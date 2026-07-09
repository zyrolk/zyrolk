import * as express from "express";
import { createHash } from "node:crypto";
import { adminDb } from "../firebase";

const MAX_CART_ITEMS = 50;
const MAX_ITEM_QUANTITY = 99;
const CHECKOUT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CHECKOUT_RATE_LIMIT_MAX_REQUESTS = 10;
const CHECKOUT_IDEMPOTENCY_COLLECTION = "checkout_idempotency";
const ALLOWED_PAYMENT_METHODS = new Set(["cod", "whatsapp_confirm"]);

const checkoutRateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

interface CheckoutCartItem {
  productId: string;
  quantity: number;
}

class CheckoutError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getClientRateLimitKey(req: express.Request): string {
  const forwardedFor = req.header("x-forwarded-for");
  const forwardedIp = forwardedFor ? forwardedFor.split(",")[0].trim() : "";
  return forwardedIp || req.ip || "unknown";
}

function enforceCheckoutRateLimit(req: express.Request): void {
  const now = Date.now();
  const key = getClientRateLimitKey(req);
  const bucket = checkoutRateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    checkoutRateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + CHECKOUT_RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  bucket.count += 1;
  if (bucket.count > CHECKOUT_RATE_LIMIT_MAX_REQUESTS) {
    throw new CheckoutError("Too many checkout attempts. Please wait a moment and try again.", 429);
  }
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

function validatePaymentMethod(paymentMethod: unknown): "cod" | "whatsapp_confirm" {
  if (paymentMethod === undefined || paymentMethod === null || paymentMethod === "") {
    return "cod";
  }

  if (typeof paymentMethod !== "string" || !ALLOWED_PAYMENT_METHODS.has(paymentMethod)) {
    throw new CheckoutError("Payment method must be cod or whatsapp_confirm");
  }

  return paymentMethod as "cod" | "whatsapp_confirm";
}

function validateCheckoutDetails(body: Record<string, unknown>): void {
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

function getIdempotencyKey(req: express.Request): string | null {
  const headerValue = req.header("Idempotency-Key");
  const bodyValue = req.body?.idempotencyKey;
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

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createCheckoutRequestHash(body: Record<string, unknown>, cartItems: CheckoutCartItem[]): string {
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

function validateCheckoutCartItems(cartItems: unknown): CheckoutCartItem[] {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new CheckoutError("Cart items are required and must not be empty");
  }

  if (cartItems.length > MAX_CART_ITEMS) {
    throw new CheckoutError(`Cart cannot contain more than ${MAX_CART_ITEMS} items`);
  }

  return cartItems.map((item, index) => {
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
}

export function registerCheckoutRoutes(app: express.Express): void {
  app.all("/api/checkout", async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Only POST requests are allowed" });
      return;
    }

    try {
      enforceCheckoutRateLimit(req);
    } catch (error: any) {
      res.status(error.statusCode || 429).json({ error: error.message || "Too many checkout attempts" });
      return;
    }

    const {
      customerUid,
      customerName,
      customerPhone,
      customerPhone2,
      customerEmail,
      customerAddress,
      district,
      city,
      paymentMethod,
      cartItems,
    } = req.body;

    let validatedCartItems: CheckoutCartItem[];
    let idempotencyKey: string | null;
    let requestHash: string;
    try {
      validateCheckoutDetails(req.body);
      validatedCartItems = validateCheckoutCartItems(cartItems);
      idempotencyKey = getIdempotencyKey(req);
      requestHash = createCheckoutRequestHash(req.body, validatedCartItems);
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ error: error.message || "Invalid checkout request" });
      return;
    }

    try {
      const finalizedOrder = await adminDb.runTransaction(async (transaction) => {
        const idempotencyRef = idempotencyKey
          ? adminDb.collection(CHECKOUT_IDEMPOTENCY_COLLECTION).doc(hashValue(idempotencyKey))
          : null;

        if (idempotencyRef) {
          const idempotencySnap = await transaction.get(idempotencyRef);
          if (idempotencySnap.exists) {
            const idempotencyData = idempotencySnap.data();

            if (idempotencyData?.requestHash !== requestHash) {
              throw new CheckoutError("Idempotency key was already used for a different checkout request", 409);
            }

            if (idempotencyData?.status === "succeeded" && idempotencyData.order) {
              return idempotencyData.order;
            }
          }
        }

        let itemsSubtotal = 0;
        const verifiedItems = [];

        for (const item of validatedCartItems) {
          const productRef = adminDb.collection("products").doc(item.productId);
          const productSnap = await transaction.get(productRef);

          if (!productSnap.exists) {
            throw new CheckoutError(`Product with ID "${item.productId}" was not found.`, 404);
          }

          const pData = productSnap.data()!;
          if (pData.isActive === false) {
            throw new CheckoutError(`Product "${pData.name || item.productId}" is not available for purchase.`, 409);
          }

          const currentStock = Number(pData.stock);
          if (!Number.isFinite(currentStock) || currentStock < item.quantity) {
            throw new CheckoutError(`Insufficient stock for product "${pData.name}". Available: ${Number.isFinite(currentStock) ? currentStock : 0}, Requested: ${item.quantity}`, 409);
          }

          const truePrice = Number(pData.price);
          if (!Number.isFinite(truePrice) || truePrice <= 0) {
            throw new Error(`Product "${pData.name}" has an invalid price configuration in the database.`);
          }

          itemsSubtotal += truePrice * item.quantity;

          verifiedItems.push({
            productId: item.productId,
            name: pData.name,
            price: truePrice,
            quantity: item.quantity,
            imageUrl: pData.imageUrl || ""
          });
        }

        const settingsRef = adminDb.collection("settings").doc("website");
        const settingsSnap = await transaction.get(settingsRef);
        const settings = settingsSnap.exists ? settingsSnap.data() : null;

        const DISTRICT_DELIVERY: Record<string, number> = {
          "Colombo": 350,
          "Gampaha": 450,
          "Kalutara": 450,
          "Kandy": 550,
          "Galle": 550,
          "Matara": 550,
          "Jaffna": 650,
          "Kurunegala": 500,
          "Anuradhapura": 600,
          "Badulla": 600,
          "Ratnapura": 500,
          "Batticaloa": 650,
          "Trincomalee": 650,
          "Other": 600
        };

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

        const grandTotalPrice = itemsSubtotal + deliveryFee;

        const counterRef = adminDb.collection("counters").doc("orders");
        const counterSnap = await transaction.get(counterRef);

        let currentSeq = 100000;
        if (counterSnap.exists) {
          const counterData = counterSnap.data()!;
          if (counterData.currentSeq !== undefined) {
            currentSeq = Number(counterData.currentSeq);
          }
        }

        const nextSeq = currentSeq + 1;
        transaction.set(counterRef, { currentSeq: nextSeq }, { merge: true });
        const orderNumber = `ZY${nextSeq}`;

        for (const item of validatedCartItems) {
          const productRef = adminDb.collection("products").doc(item.productId);
          const productSnap = await transaction.get(productRef);
          const currentStock = productSnap.data()!.stock || 0;
          transaction.update(productRef, {
            stock: Math.max(0, currentStock - item.quantity)
          });
        }

        const orderRef = adminDb.collection("orders").doc();
        const orderData = {
          orderNumber,
          customerUid: customerUid || "guest",
          customerName,
          customerPhone,
          customerPhone2: customerPhone2 || "",
          customerEmail: customerEmail || "guest@zyro.lk",
          customerAddress,
          district,
          city: city || "",
          items: verifiedItems,
          totalPrice: grandTotalPrice,
          status: "pending",
          paymentMethod: paymentMethod || "cod",
          createdAt: new Date().toISOString()
        };

        transaction.set(orderRef, orderData);

        const order = {
          id: orderRef.id,
          ...orderData
        };

        if (idempotencyRef) {
          transaction.set(idempotencyRef, {
            keyHash: hashValue(idempotencyKey!),
            requestHash,
            status: "succeeded",
            orderId: orderRef.id,
            orderNumber,
            order,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        }

        return order;
      });

      res.json({ success: true, order: finalizedOrder });
    } catch (error: any) {
      console.error("Cloud Function Checkout Failed:", error);
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to process checkout transaction" });
    }
  });
}
