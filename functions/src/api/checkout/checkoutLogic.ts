import { createHash } from "node:crypto";

export const MAX_CART_ITEMS = 50;
export const MAX_ITEM_QUANTITY = 99;
export const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const CHECKOUT_RATE_LIMIT_MAX_REQUESTS = 10;
export const CHECKOUT_IDEMPOTENCY_COLLECTION = "checkout_idempotency";

const ALLOWED_PAYMENT_METHODS = new Set(["cod", "whatsapp_confirm"]);

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
  deliveryFee: number;
  grandTotalPrice: number;
  freeDeliveryThreshold: number;
  baseDeliveryCharge: number;
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

export function validatePaymentMethod(paymentMethod: unknown): "cod" | "whatsapp_confirm" {
  if (paymentMethod === undefined || paymentMethod === null || paymentMethod === "") {
    return "cod";
  }

  if (typeof paymentMethod !== "string" || !ALLOWED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new CheckoutError("Payment method must be cod or whatsapp_confirm");
  }

  return paymentMethod as "cod" | "whatsapp_confirm";
}

export function validateCheckoutDetails(body: Record<string, unknown>): void {
  requireNonEmptyString(body.customerName, "Customer name", 120);
  const customerPhone = requireNonEmptyString(body.customerPhone, "Phone", 30);
  requireNonEmptyString(body.customerAddress, "Address", 500);
  requireNonEmptyString(body.district, "District", 80);
  validatePaymentMethod(body.paymentMethod);

  const phoneDigits = customerPhone.replace(/\D/g, "");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    throw new CheckoutError("Phone must contain a valid contact number");
  }

  if (body.customerEmail !== undefined && body.customerEmail !== null && body.customerEmail !== "") {
    const email = String(body.customerEmail).trim();
    if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CheckoutError("Customer email must be valid when provided");
    }
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
    cartItems,
  };

  return hashValue(JSON.stringify(requestShape));
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

  return {
    itemsSubtotal,
    deliveryFee,
    grandTotalPrice: itemsSubtotal + deliveryFee,
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
