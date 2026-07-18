import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { appendPaymentTimeline, createPaymentTimelineEvent } from "../api/payments/payhereLogic";

async function expireReservation(orderRef: FirebaseFirestore.DocumentReference): Promise<boolean> {
  return adminDb.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return false;
    const order = orderSnapshot.data()!;
    const expiresAt = order.stockReservationExpiresAt instanceof Timestamp
      ? order.stockReservationExpiresAt.toMillis()
      : new Date(order.stockReservationExpiresAt || 0).getTime();
    if (!new Set(["awaiting_payment", "pending"]).has(order.paymentStatus) || order.stockReservationStatus !== "reserved" || expiresAt > Date.now()) return false;

    const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number }> = [];
    for (const item of Array.isArray(order.items) ? order.items : []) {
      const productId = typeof item?.productId === "string" ? item.productId.trim() : "";
      const quantity = Number(item?.quantity);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) continue;
      const productRef = adminDb.collection("products").doc(productId);
      const productSnapshot = await transaction.get(productRef);
      if (productSnapshot.exists) {
        const stock = Number(productSnapshot.data()?.stock);
        productUpdates.push({ ref: productRef, stock: (Number.isFinite(stock) ? stock : 0) + quantity });
      }
    }

    productUpdates.forEach((update) => transaction.update(update.ref, { stock: update.stock }));
    transaction.update(orderRef, {
      paymentStatus: "expired",
      paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent("expired", "Payment window expired and reserved stock was released", "system")),
      stockReservationStatus: "released",
      stockRestorationApplied: true,
      stockRestoredAt: FieldValue.serverTimestamp(),
      status: "cancelled",
      statusUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (typeof order.paymentGatewayOrderId === "string") {
      transaction.set(adminDb.collection("payment_transactions").doc(order.paymentGatewayOrderId), {
        status: "expired",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return true;
  });
}

export const expirePaymentReservations = onSchedule("every 5 minutes", async () => {
  const snapshot = await adminDb.collection("orders")
    .where("stockReservationStatus", "==", "reserved")
    .where("stockReservationExpiresAt", "<=", Timestamp.now())
    .limit(100)
    .get();
  const results = await Promise.all(snapshot.docs.map((order) => expireReservation(order.ref)));
  const expiredCount = results.filter(Boolean).length;
  if (expiredCount) appLogger.info("Expired PayHere stock reservations.", { expiredCount });
});
