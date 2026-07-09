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
import { adminDb } from "../firebase";

const enforceCheckoutRateLimit = createCheckoutRateLimiter();

export function registerCheckoutRoutes(app: express.Express): void {
  app.all("/api/checkout", async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Only POST requests are allowed" });
      return;
    }

    try {
      enforceCheckoutRateLimit(getClientRateLimitKey(req.header("x-forwarded-for"), req.ip));
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
      idempotencyKey = getIdempotencyKeyFromValues(req.header("Idempotency-Key"), req.body?.idempotencyKey);
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
            const idempotencyDecision = resolveCheckoutIdempotency(idempotencyData || null, requestHash);
            if (idempotencyDecision.action === "return-order") {
              return idempotencyDecision.order;
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
