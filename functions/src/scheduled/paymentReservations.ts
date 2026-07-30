import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { appendPaymentTimeline, createPaymentTimelineEvent } from "../api/payments/payhereLogic";
import { collectOrderStockQuantities, requireCurrentProductStock } from "../api/orders/orderStatusLogic";

async function expireReservation(orderRef: FirebaseFirestore.DocumentReference): Promise<boolean> {
  return adminDb.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return false;
    const order = orderSnapshot.data()!;
    const expiresAt = order.stockReservationExpiresAt instanceof Timestamp
      ? order.stockReservationExpiresAt.toMillis()
      : new Date(order.stockReservationExpiresAt || 0).getTime();
    const isPayHereReservation = order.paymentMethod === "payhere"
      && new Set(["awaiting_payment", "pending"]).has(String(order.paymentStatus || ""));
    const isOfflineConfirmationReservation = order.paymentMethod !== "payhere"
      && String(order.status || "pending") === "pending"
      && order.paymentStatus === "not_required";
    if ((!isPayHereReservation && !isOfflineConfirmationReservation) || order.stockReservationStatus !== "reserved" || expiresAt > Date.now()) return false;

    const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number }> = [];
    for (const [productId, quantity] of collectOrderStockQuantities(order.items)) {
      const productRef = adminDb.collection("products").doc(productId);
      const productSnapshot = await transaction.get(productRef);
      const stock = requireCurrentProductStock(productSnapshot.exists, productSnapshot.data()?.stock);
      productUpdates.push({ ref: productRef, stock: stock + quantity });
    }

    productUpdates.forEach((update) => transaction.update(update.ref, { stock: update.stock }));
    transaction.update(orderRef, {
      ...(isPayHereReservation ? { paymentStatus: "expired" } : { reservationExpiredReason: "cod_confirmation_expired" }),
      paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent(
        "expired",
        isPayHereReservation
          ? "Payment window expired and reserved stock was released"
          : "Cash-on-delivery confirmation window expired and reserved stock was released",
        "system",
      )),
      stockReservationStatus: "released",
      stockRestorationApplied: true,
      stockRestoredAt: FieldValue.serverTimestamp(),
      status: "cancelled",
      statusUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (isPayHereReservation && typeof order.paymentGatewayOrderId === "string") {
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
  const results = await Promise.allSettled(snapshot.docs.map((order) => expireReservation(order.ref)));
  const expiredCount = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const failedCount = results.filter((result) => result.status === "rejected").length;
  if (expiredCount) appLogger.info("Expired unconfirmed stock reservations.", { expiredCount });
  if (failedCount) appLogger.error("Some expired stock reservations could not be reconciled.", { failedCount });
});
