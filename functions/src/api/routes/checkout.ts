import * as express from "express";
import {
  CHECKOUT_ABUSE_COLLECTION,
  CHECKOUT_IDEMPOTENCY_COLLECTION,
  COD_CONFIRMATION_WINDOW_MS,
  calculateCheckoutTotals,
  CheckoutCartItem,
  CheckoutError,
  createCheckoutRateLimiter,
  createCheckoutRequestHash,
  getClientRateLimitKey,
  getIdempotencyKeyFromValues,
  getCouponDocumentId,
  hashValue,
  nextCheckoutAbuseCounter,
  normalizeCouponCode,
  OFFLINE_CHECKOUT_NETWORK_LIMIT,
  OFFLINE_CHECKOUT_PHONE_LIMIT,
  resolveCouponDiscount,
  resolveCheckoutIdempotency,
  validateCheckoutCartItems,
  validateCheckoutDetails,
  validatePaymentMethod,
} from "../checkout/checkoutLogic";
import { sendApiError } from "../errors";
import { adminAuth, adminDb } from "../firebase";
import { appLogger } from "../logging";

const enforceCheckoutRateLimit = createCheckoutRateLimiter();
const enforceCouponRateLimit = createCheckoutRateLimiter();

interface CheckoutOrderResponse {
  id: string;
  orderNumber: string;
  [key: string]: unknown;
}

async function resolveCheckoutCustomerUid(authorization: string | undefined): Promise<string> {
  const match = (authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return "guest";
  try {
    return (await adminAuth.verifyIdToken(match[1])).uid;
  } catch {
    throw new CheckoutError("Invalid or expired authentication token", 401);
  }
}

async function calculateTrustedCouponSubtotal(cartItems: CheckoutCartItem[]): Promise<number> {
  let subtotal = 0;
  for (const item of cartItems) {
    const snapshot = await adminDb.collection("products").doc(item.productId).get();
    if (!snapshot.exists || snapshot.data()?.isActive === false) throw new CheckoutError("A cart item is no longer available", 409);
    const data = snapshot.data()!;
    const price = Number(data.price);
    const stock = Number(data.stock);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock < item.quantity) {
      throw new CheckoutError("A cart item has changed. Review your cart and try again.", 409);
    }
    subtotal += price * item.quantity;
  }
  return subtotal;
}

export function registerCheckoutRoutes(app: express.Express): void {
  app.post("/api/checkout/coupon", async (req, res) => {
    try {
      enforceCouponRateLimit(getClientRateLimitKey(req.header("x-forwarded-for"), req.ip));
      const code = normalizeCouponCode(req.body?.couponCode);
      const cartItems = validateCheckoutCartItems(req.body?.cartItems);
      const itemsSubtotal = await calculateTrustedCouponSubtotal(cartItems);
      const couponSnapshot = await adminDb.collection("checkout_coupons").doc(getCouponDocumentId(code)).get();
      const discountAmount = resolveCouponDiscount(couponSnapshot.exists ? couponSnapshot.data() || null : null, itemsSubtotal);
      res.json({ success: true, code, discountAmount, itemsSubtotal });
    } catch (error: any) {
      sendApiError(res, error, {
        logMessage: "Checkout coupon validation failed.",
        fallbackMessage: "Coupon could not be applied",
        fallbackStatusCode: 400,
        context: { route: "/api/checkout/coupon" },
      });
    }
  });

  app.all("/api/checkout", async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Only POST requests are allowed" });
      return;
    }

    try {
      enforceCheckoutRateLimit(getClientRateLimitKey(req.header("x-forwarded-for"), req.ip));
    } catch (error: any) {
      sendApiError(res, error, {
        logMessage: "Checkout rate limit rejected request.",
        fallbackMessage: "Too many checkout attempts",
        fallbackStatusCode: 429,
        context: {
          route: "/api/checkout",
          reason: "rate_limit",
        },
      });
      return;
    }

    const {
      customerUid: requestedCustomerUid,
      customerName,
      customerPhone,
      customerPhone2,
      customerEmail,
      customerAddress,
      district,
      city,
      paymentMethod,
      cartItems,
      couponCode: requestedCouponCode,
    } = req.body;

    let customerUid: string;
    let validatedCartItems: CheckoutCartItem[];
    let idempotencyKey: string | null;
    let requestHash: string;
    let validatedPaymentMethod: "cod" | "whatsapp_confirm" | "payhere";
    try {
      customerUid = await resolveCheckoutCustomerUid(req.header("Authorization"));
      if (requestedCustomerUid && requestedCustomerUid !== "guest" && requestedCustomerUid !== customerUid) {
        throw new CheckoutError("Checkout customer identity does not match the signed-in account", 403);
      }
      validateCheckoutDetails(req.body);
      validatedPaymentMethod = validatePaymentMethod(paymentMethod);
      validatedCartItems = validateCheckoutCartItems(cartItems);
      idempotencyKey = getIdempotencyKeyFromValues(req.header("Idempotency-Key"), req.body?.idempotencyKey);
      requestHash = createCheckoutRequestHash(req.body, validatedCartItems);
      if (paymentMethod && paymentMethod !== "cod") throw new CheckoutError("Only Cash on Delivery is currently available", 400);
    } catch (error: any) {
      sendApiError(res, error, {
        logMessage: "Checkout validation failed.",
        fallbackMessage: "Invalid checkout request",
        fallbackStatusCode: 400,
        context: {
          route: "/api/checkout",
          reason: "validation",
        },
      });
      return;
    }

    try {
      appLogger.info("Checkout transaction started.", {
        route: "/api/checkout",
        customerUid: customerUid || "guest",
        cartItemsCount: validatedCartItems.length,
        idempotencyKeyProvided: !!idempotencyKey,
      });

      const finalizedOrder = await adminDb.runTransaction<CheckoutOrderResponse>(async (transaction) => {
        const idempotencyRef = idempotencyKey
          ? adminDb.collection(CHECKOUT_IDEMPOTENCY_COLLECTION).doc(hashValue(idempotencyKey))
          : null;

        if (idempotencyRef) {
          const idempotencySnap = await transaction.get(idempotencyRef);
          if (idempotencySnap.exists) {
            const idempotencyData = idempotencySnap.data();
            const idempotencyDecision = resolveCheckoutIdempotency(idempotencyData || null, requestHash);
            if (idempotencyDecision.action === "return-order") {
            return idempotencyDecision.order as CheckoutOrderResponse;
            }
          }
        }

        const checkoutNetworkKey = getClientRateLimitKey(req.header("x-forwarded-for"), req.ip);
        const offlineLimitRefs = validatedPaymentMethod === "payhere" ? [] : [
          {
            ref: adminDb.collection(CHECKOUT_ABUSE_COLLECTION).doc(hashValue(`offline-phone:${String(customerPhone).replace(/\D/gu, "")}`)),
            maximum: OFFLINE_CHECKOUT_PHONE_LIMIT,
          },
          {
            ref: adminDb.collection(CHECKOUT_ABUSE_COLLECTION).doc(hashValue(`offline-network:${checkoutNetworkKey}`)),
            maximum: OFFLINE_CHECKOUT_NETWORK_LIMIT,
          },
        ];
        const offlineLimitSnapshots = await Promise.all(offlineLimitRefs.map(({ ref }) => transaction.get(ref)));
        const offlineLimitUpdates = offlineLimitRefs.map(({ ref, maximum }, index) => ({
          ref,
          data: nextCheckoutAbuseCounter(offlineLimitSnapshots[index].data() || null, maximum),
        }));

        let itemsSubtotal = 0;
        const verifiedItems = [];
        const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; newStock: number }> = [];

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

          productUpdates.push({
            ref: productRef,
            newStock: currentStock - item.quantity,
          });
        }

        const settingsRef = adminDb.collection("settings").doc("website");
        const settingsSnap = await transaction.get(settingsRef);
        const settings = settingsSnap.exists ? settingsSnap.data() : null;

        const couponCode = requestedCouponCode ? normalizeCouponCode(requestedCouponCode) : "";
        let discountAmount = 0;
        if (couponCode) {
          const couponRef = adminDb.collection("checkout_coupons").doc(getCouponDocumentId(couponCode));
          const couponSnapshot = await transaction.get(couponRef);
          discountAmount = resolveCouponDiscount(couponSnapshot.exists ? couponSnapshot.data() || null : null, itemsSubtotal);
        }

        const totals = calculateCheckoutTotals(itemsSubtotal, district, settings || null, discountAmount);

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
        offlineLimitUpdates.forEach(({ ref, data }) => transaction.set(ref, data, { merge: true }));
        const orderNumber = `ZY${nextSeq}`;

        for (const update of productUpdates) {
          transaction.update(update.ref, {
            stock: Math.max(0, update.newStock),
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
          itemsSubtotal: totals.itemsSubtotal,
          discountAmount: totals.discountAmount,
          deliveryFee: totals.deliveryFee,
          totalPrice: totals.grandTotalPrice,
          ...(couponCode ? { couponCode } : {}),
          status: "pending",
          stockDeducted: true,
          paymentMethod: validatedPaymentMethod,
          paymentStatus: "not_required",
          stockReservationStatus: "reserved",
          stockReservationExpiresAt: new Date(Date.now() + COD_CONFIRMATION_WINDOW_MS),
          stockRestorationApplied: false,
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

      appLogger.info("Checkout transaction completed.", {
        route: "/api/checkout",
        orderId: finalizedOrder.id,
        orderNumber: finalizedOrder.orderNumber,
      });

      res.json({
        success: true,
        order: finalizedOrder,
      });
    } catch (error: any) {
      sendApiError(res, error, {
        logMessage: "Checkout transaction failed.",
        fallbackMessage: "Failed to process checkout transaction",
        context: {
          route: "/api/checkout",
          customerUid: customerUid || "guest",
          cartItemsCount: validatedCartItems.length,
          idempotencyKeyProvided: !!idempotencyKey,
        },
      });
    }
  });
}
