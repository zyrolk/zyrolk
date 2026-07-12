import * as express from "express";
import {
  CHECKOUT_IDEMPOTENCY_COLLECTION,
  calculateCheckoutTotals,
  CheckoutCartItem,
  CheckoutError,
  createCheckoutRateLimiter,
  createCheckoutRequestHash,
  getClientRateLimitKey,
  getIdempotencyKeyFromValues,
  hashValue,
  resolveCheckoutIdempotency,
  validateCheckoutCartItems,
  validateCheckoutDetails,
} from "../checkout/checkoutLogic";
import { sendApiError } from "../errors";
import { adminDb } from "../firebase";
import { appLogger } from "../logging";

const enforceCheckoutRateLimit = createCheckoutRateLimiter();

interface CheckoutOrderResponse {
  id: string;
  orderNumber: string;
  [key: string]: unknown;
}

export function registerCheckoutRoutes(app: express.Express): void {
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
      idempotencyKey = getIdempotencyKeyFromValues(req.header("Idempotency-Key"), req.body?.idempotencyKey);
      requestHash = createCheckoutRequestHash(req.body, validatedCartItems);
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

        const { grandTotalPrice } = calculateCheckoutTotals(itemsSubtotal, district, settings || null);

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
          totalPrice: grandTotalPrice,
          status: "pending",
          stockDeducted: true,
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

      appLogger.info("Checkout transaction completed.", {
        route: "/api/checkout",
        orderId: finalizedOrder.id,
        orderNumber: finalizedOrder.orderNumber,
      });

      res.json({ success: true, order: finalizedOrder });
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
