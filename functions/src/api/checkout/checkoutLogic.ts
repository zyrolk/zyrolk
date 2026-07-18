import { createHash } from "node:crypto";

export const MAX_CART_ITEMS = 50;
export const MAX_ITEM_QUANTITY = 99;
export const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const CHECKOUT_RATE_LIMIT_MAX_REQUESTS = 10;
export const CHECKOUT_IDEMPOTENCY_COLLECTION = "checkout_idempotency";

const ALLOWED_PAYMENT_METHODS = new Set(["cod", "whatsapp_confirm", "payhere"]);

export interface CheckoutCartItem {
  productId: string;
  quantity: number;
}

export interface CheckoutSettings {
  deliveryCharge?: unknown;
  freeDeliveryMin?: unknown;
}

export interface CheckoutTotals {
  itemsSubtotal: number;
  discountAmount: number;
  deliveryFee: number;
  grandTotalPrice: number;
  freeDeliveryThreshold: number;
  baseDeliveryCharge: number;
}

export interface CheckoutCouponRecord {
  active?: unknown;
  type?: unknown;
  value?: unknown;
  minSubtotal?: unknown;
  maxDiscount?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
}

export interface CheckoutRateLimitBucket {
  count: number;
  resetAt: number;
}

export interface CheckoutIdempotencyRecord {
  requestHash?: unknown;
  status?: unknown;
  order?: unknown;
}

export type CheckoutIdempotencyDecision =
  | { action: "proceed" }
  | { action: "return-order"; order: unknown };

export class CheckoutError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function getClientRateLimitKey(forwardedFor: string | undefined, ip: string | undefined): string {
  const forwardedIp = forwardedFor ? forwardedFor.split(",")[0].trim() : "";
  return forwardedIp || ip || "unknown";
}

export function createCheckoutRateLimiter(
  buckets = new Map<string, CheckoutRateLimitBucket>(),
  windowMs = CHECKOUT_RATE_LIMIT_WINDOW_MS,
  maxRequests = CHECKOUT_RATE_LIMIT_MAX_REQUESTS,
) {
  return (key: string, now = Date.now()): void => {
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return;
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      throw new CheckoutError("Too many checkout attempts. Please wait a moment and try again.", 429);
    }
  };
}

function requireNonEmptyString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new CheckoutError(`${fieldName} is required`);
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new CheckoutError(`${fieldName} is required`);
  }

  if (trimmedValue.length > maxLength) {
    throw new CheckoutError(`${fieldName} cannot exceed ${maxLength} characters`);
  }

  return trimmedValue;
}

export function validatePaymentMethod(paymentMethod: unknown): "cod" | "whatsapp_confirm" | "payhere" {
  if (paymentMethod === undefined || paymentMethod === null || paymentMethod === "") {
    return "cod";
  }

  if (typeof paymentMethod !== "string" || !ALLOWED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new CheckoutError("Payment method must be cod, whatsapp_confirm or payhere");
  }

  return paymentMethod as "cod" | "whatsapp_confirm" | "payhere";
}

export function validateCheckoutDetails(body: Record<string, unknown>): void {
  requireNonEmptyString(body.customerName, "Customer name", 120);
  const customerPhone = requireNonEmptyString(body.customerPhone, "Phone", 30);
  requireNonEmptyString(body.customerAddress, "Address", 500);
  requireNonEmptyString(body.district, "District", 80);
  const validatedPaymentMethod = validatePaymentMethod(body.paymentMethod);

  if (body.city !== undefined && body.city !== null && String(body.city).trim().length > 80) {
    throw new CheckoutError("City cannot exceed 80 characters");
  }

  if (body.couponCode !== undefined && body.couponCode !== null && body.couponCode !== "") {
    normalizeCouponCode(body.couponCode);
  }

  const phoneDigits = customerPhone.replace(/\D/g, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    throw new CheckoutError("Phone must contain a valid contact number");
  }

  if (body.customerEmail !== undefined && body.customerEmail !== null && body.customerEmail !== "") {
    const email = String(body.customerEmail).trim();
    if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CheckoutError("Customer email must be valid when provided");
    }
    if (validatedPaymentMethod === "payhere" && email.toLowerCase() === "guest@zyro.lk") {
      throw new CheckoutError("A customer email is required for PayHere payments");
    }
  } else if (validatedPaymentMethod === "payhere") {
    throw new CheckoutError("Customer email is required for PayHere payments");
  }

  if (body.customerPhone2 !== undefined && body.customerPhone2 !== null && body.customerPhone2 !== "") {
    const phone2Digits = String(body.customerPhone2).replace(/\D/g, "");
    if (phone2Digits.length < 9 || phone2Digits.length > 15) {
      throw new CheckoutError("Secondary phone must contain a valid contact number when provided");
    }
  }
}

export function getIdempotencyKeyFromValues(headerValue: unknown, bodyValue: unknown): string | null {
  const rawKey = typeof headerValue === "string" && headerValue.trim()
    ? headerValue
    : (typeof bodyValue === "string" ? bodyValue : "");
  const key = rawKey.trim();

  if (!key) {
    return null;
  }

  if (key.length > 200) {
    throw new CheckoutError("Idempotency key cannot exceed 200 characters");
  }

  return key;
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createCheckoutRequestHash(body: Record<string, unknown>, cartItems: CheckoutCartItem[]): string {
  const requestShape = {
    customerUid: body.customerUid || "guest",
    customerName: String(body.customerName || "").trim(),
    customerPhone: String(body.customerPhone || "").trim(),
    customerPhone2: String(body.customerPhone2 || "").trim(),
    customerEmail: String(body.customerEmail || "guest@zyro.lk").trim(),
    customerAddress: String(body.customerAddress || "").trim(),
    district: String(body.district || "").trim(),
    city: String(body.city || "").trim(),
    paymentMethod: validatePaymentMethod(body.paymentMethod),
    couponCode: body.couponCode ? normalizeCouponCode(body.couponCode) : "",
    cartItems,
  };

  return hashValue(JSON.stringify(requestShape));
}

export function normalizeCouponCode(value: unknown): string {
  if (typeof value !== "string") throw new CheckoutError("Coupon code must be text");
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    throw new CheckoutError("Enter a valid coupon code");
  }
  return code;
}

export function getCouponDocumentId(code: string): string {
  return hashValue(`checkout-coupon:${normalizeCouponCode(code)}`);
}

function couponTime(value: unknown): number | null {
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

export function resolveCouponDiscount(coupon: CheckoutCouponRecord | null, itemsSubtotal: number, now = Date.now()): number {
  if (!coupon || coupon.active !== true) throw new CheckoutError("This coupon is not valid or is no longer active", 409);
  const startsAt = couponTime(coupon.startsAt);
  const expiresAt = couponTime(coupon.expiresAt);
  if (startsAt !== null && now < startsAt) throw new CheckoutError("This coupon is not active yet", 409);
  if (expiresAt !== null && now > expiresAt) throw new CheckoutError("This coupon has expired", 409);

  const minSubtotal = Math.max(0, Number(coupon.minSubtotal) || 0);
  if (itemsSubtotal < minSubtotal) {
    throw new CheckoutError(`This coupon requires a minimum subtotal of LKR ${Math.round(minSubtotal)}`, 409);
  }

  const value = Number(coupon.value);
  if (!Number.isFinite(value) || value <= 0) throw new CheckoutError("This coupon is not configured correctly", 409);
  let discount: number;
  if (coupon.type === "percentage") {
    if (value > 100) throw new CheckoutError("This coupon is not configured correctly", 409);
    discount = itemsSubtotal * (value / 100);
  } else if (coupon.type === "fixed") {
    discount = value;
  } else {
    throw new CheckoutError("This coupon is not configured correctly", 409);
  }

  const maxDiscount = Number(coupon.maxDiscount);
  if (Number.isFinite(maxDiscount) && maxDiscount > 0) discount = Math.min(discount, maxDiscount);
  return Math.min(itemsSubtotal, Math.max(0, Math.round(discount)));
}

export function validateCheckoutCartItems(cartItems: unknown): CheckoutCartItem[] {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new CheckoutError("Cart items are required and must not be empty");
  }

  if (cartItems.length > MAX_CART_ITEMS) {
    throw new CheckoutError(`Cart cannot contain more than ${MAX_CART_ITEMS} items`);
  }

  const normalizedItems = cartItems.map((item, index) => {
    const rawItem = item as Partial<CheckoutCartItem>;
    const productId = typeof rawItem.productId === "string" ? rawItem.productId.trim() : "";
    const quantity = typeof rawItem.quantity === "number" ? rawItem.quantity : NaN;

    if (!productId) {
      throw new CheckoutError(`Cart item ${index + 1} is missing a valid product ID`);
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
      throw new CheckoutError(`Cart item ${index + 1} must have a quantity between 1 and ${MAX_ITEM_QUANTITY}`);
    }

    return { productId, quantity };
  });

  const consolidated = new Map<string, number>();
  normalizedItems.forEach(({ productId, quantity }) => {
    const combinedQuantity = (consolidated.get(productId) || 0) + quantity;
    if (combinedQuantity > MAX_ITEM_QUANTITY) {
      throw new CheckoutError(`Combined quantity for product "${productId}" cannot exceed ${MAX_ITEM_QUANTITY}`);
    }
    consolidated.set(productId, combinedQuantity);
  });

  return Array.from(consolidated, ([productId, quantity]) => ({ productId, quantity }));
}

const DISTRICT_DELIVERY: Record<string, number> = {
  Colombo: 350,
  Gampaha: 450,
  Kalutara: 450,
  Kandy: 550,
  Galle: 550,
  Matara: 550,
  Jaffna: 650,
  Kurunegala: 500,
  Anuradhapura: 600,
  Badulla: 600,
  Ratnapura: 500,
  Batticaloa: 650,
  Trincomalee: 650,
  Other: 600,
};

export function calculateCheckoutTotals(
  itemsSubtotal: number,
  district: string,
  settings: CheckoutSettings | null,
  discountAmount = 0,
): CheckoutTotals {
  const baseDeliveryCharge = (settings && settings.deliveryCharge !== undefined)
    ? Number(settings.deliveryCharge)
    : (DISTRICT_DELIVERY[district] || 500);

  const freeDeliveryThreshold = (settings && settings.freeDeliveryMin !== undefined)
    ? Number(settings.freeDeliveryMin)
    : 5000;

  const isEligibleForFreeDelivery = itemsSubtotal >= freeDeliveryThreshold;
  const deliveryFee = itemsSubtotal > 0
    ? (isEligibleForFreeDelivery ? 0 : baseDeliveryCharge)
    : 0;

  const safeDiscount = Math.min(itemsSubtotal, Math.max(0, Number(discountAmount) || 0));

  return {
    itemsSubtotal,
    discountAmount: safeDiscount,
    deliveryFee,
    grandTotalPrice: itemsSubtotal - safeDiscount + deliveryFee,
    freeDeliveryThreshold,
    baseDeliveryCharge,
  };
}

export function resolveCheckoutIdempotency(
  existingRecord: CheckoutIdempotencyRecord | null,
  requestHash: string,
): CheckoutIdempotencyDecision {
  if (!existingRecord) {
    return { action: "proceed" };
  }

  if (existingRecord.requestHash !== requestHash) {
    throw new CheckoutError("Idempotency key was already used for a different checkout request", 409);
  }

  if (existingRecord.status === "succeeded" && existingRecord.order) {
    return { action: "return-order", order: existingRecord.order };
  }

  return { action: "proceed" };
}
