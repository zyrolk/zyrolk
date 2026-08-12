import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { appendPaymentTimeline, createPaymentTimelineEvent } from "../api/payments/payhereLogic";
import {
  collectOrderStockQuantities,
  hasSupplierAssignment,
  hasSupplierFulfilmentStarted,
  requireCurrentProductStock,
} from "../api/orders/orderStatusLogic";

type ReservationExpiryOutcome = "expired" | "not_eligible" | "blocked_by_fulfilment";

export async function expireReservation(
  orderRef: FirebaseFirestore.DocumentReference,
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<boolean> {
  const outcome = await db.runTransaction<ReservationExpiryOutcome>(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return "not_eligible";
    const order = orderSnapshot.data()!;
    const expiresAt = order.stockReservationExpiresAt instanceof Timestamp
      ? order.stockReservationExpiresAt.toMillis()
      : new Date(order.stockReservationExpiresAt || 0).getTime();
    const isPayHereReservation = order.paymentMethod === "payhere"
      && new Set(["awaiting_payment", "pending"]).has(String(order.paymentStatus || ""));
    const isOfflineConfirmationReservation = order.paymentMethod !== "payhere"
      && order.paymentStatus === "not_required";
    const isPending = String(order.status || "pending").trim().toLowerCase() === "pending";
    if ((!isPayHereReservation && !isOfflineConfirmationReservation)
      || !isPending
      || order.stockReservationStatus !== "reserved"
      || expiresAt > Date.now()) return "not_eligible";
    if (hasSupplierAssignment(order) || hasSupplierFulfilmentStarted(order.supplierFulfilmentStatus)) {
      return "blocked_by_fulfilment";
    }

    const productUpdates: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number }> = [];
    for (const [productId, quantity] of collectOrderStockQuantities(order.items)) {
      const productRef = db.collection("products").doc(productId);
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
      transaction.set(db.collection("payment_transactions").doc(order.paymentGatewayOrderId), {
        status: "expired",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return "expired";
  });
  if (outcome === "blocked_by_fulfilment") {
    appLogger.error("Reservation expiry was blocked by supplier assignment or fulfilment state.", {
      orderId: orderRef.id,
    });
  }
  return outcome === "expired";
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
