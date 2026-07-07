import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK
initializeApp();
const adminDb = getFirestore();

/**
 * Production-ready Firebase Cloud Function for secure, transaction-based checkout.
 * Validates products, secures prices directly from DB, verifies stock,
 * decrements stock atomically, generates sequential order numbers, and saves the order.
 */
export const checkout = onRequest({ cors: true }, async (req, res) => {
  // CORS Headers support
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

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
    cartItems, // Array of { productId, quantity }
  } = req.body;

  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    res.status(400).json({ error: "Cart items are required and must not be empty" });
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

      // 1. Fetch, validate, and price each product inside the transaction
      for (const item of cartItems) {
        const productRef = adminDb.collection("products").doc(item.productId);
        const productSnap = await transaction.get(productRef);

        if (!productSnap.exists) {
          throw new Error(`Product with ID "${item.productId}" was not found.`);
        }

        const pData = productSnap.data()!;
        if (pData.stock === undefined || pData.stock < item.quantity) {
          throw new Error(`Insufficient stock for product "${pData.name}". Available: ${pData.stock || 0}, Requested: ${item.quantity}`);
        }

        const truePrice = Number(pData.price);
        if (isNaN(truePrice)) {
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

      // 2. Fetch shipping options from website settings securely
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

      // 3. Generate a sequential order number using a central counter document
      const counterRef = adminDb.collection("counters").doc("orders");
      const counterSnap = await transaction.get(counterRef);
      
      let currentSeq = 100000; // start index so first order is ZY100001
      if (counterSnap.exists) {
        const counterData = counterSnap.data()!;
        if (counterData.currentSeq !== undefined) {
          currentSeq = Number(counterData.currentSeq);
        }
      }
      
      const nextSeq = currentSeq + 1;
      transaction.set(counterRef, { currentSeq: nextSeq }, { merge: true });
      const orderNumber = `ZY${nextSeq}`;

      // 4. Atomically decrease product stock
      for (const item of cartItems) {
        const productRef = adminDb.collection("products").doc(item.productId);
        const productSnap = await transaction.get(productRef); // read inside transaction
        const currentStock = productSnap.data()!.stock || 0;
        transaction.update(productRef, {
          stock: Math.max(0, currentStock - item.quantity)
        });
      }

      // 5. Store the finalized order document
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
    res.status(500).json({ error: error.message || "Failed to process checkout transaction" });
  }
});
