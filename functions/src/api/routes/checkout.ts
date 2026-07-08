import * as express from "express";
import { adminDb } from "../firebase";

const MAX_CART_ITEMS = 50;
const MAX_ITEM_QUANTITY = 99;

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
    try {
      validatedCartItems = validateCheckoutCartItems(cartItems);
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ error: error.message || "Invalid cart items" });
      return;
    }

    if (!customerName || !customerPhone || !customerAddress || !district) {
      res.status(400).json({ error: "Required customer details (name, phone, address, district) are missing" });
      return;
    }

    try {
      const finalizedOrder = await adminDb.runTransaction(async (transaction) => {
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

        return {
          id: orderRef.id,
          ...orderData
        };
      });

      res.json({ success: true, order: finalizedOrder });
    } catch (error: any) {
      console.error("Cloud Function Checkout Failed:", error);
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to process checkout transaction" });
    }
  });
}
