import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { ORDER_EMAIL_MAX_ATTEMPTS } from "../api/orders/orderNotificationLogic";

async function retryOrderNotification(reference: FirebaseFirestore.DocumentReference): Promise<boolean> {
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return false;
    const notification = snapshot.data()!;
    const nextRetryAt = notification.nextRetryAt instanceof Timestamp
      ? notification.nextRetryAt.toMillis()
      : new Date(notification.nextRetryAt || 0).getTime();
    if (notification.status !== "retry_pending" || !Number.isFinite(nextRetryAt) || nextRetryAt > Date.now()) return false;

    const attemptCount = Math.max(1, Math.floor(Number(notification.attemptCount) || 1));
    const maxAttempts = Math.max(1, Math.floor(Number(notification.maxAttempts) || ORDER_EMAIL_MAX_ATTEMPTS));
    if (attemptCount >= maxAttempts) {
      transaction.update(reference, {
        status: "failed",
        nextRetryAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return false;
    }

    const currentMailId = typeof notification.currentMailId === "string" ? notification.currentMailId : "";
    if (!currentMailId) {
      transaction.update(reference, {
        status: "failed",
        nextRetryAt: FieldValue.delete(),
        lastError: "Email retry source is unavailable.",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return false;
    }
    const currentMailReference = adminDb.collection("mail").doc(currentMailId);
    const currentMailSnapshot = await transaction.get(currentMailReference);
    const currentMail = currentMailSnapshot.data();
    if (!currentMailSnapshot.exists || !currentMail?.message || !Array.isArray(currentMail.to)) {
      transaction.update(reference, {
        status: "failed",
        nextRetryAt: FieldValue.delete(),
        lastError: "Email retry source is unavailable.",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return false;
    }

    const nextAttempt = attemptCount + 1;
    const nextMailId = `${reference.id}-attempt-${nextAttempt}`;
    transaction.create(adminDb.collection("mail").doc(nextMailId), {
      to: currentMail.to,
      message: currentMail.message,
      metadata: {
        ...(currentMail.metadata && typeof currentMail.metadata === "object" ? currentMail.metadata : {}),
        notificationId: reference.id,
        deliveryAttempt: nextAttempt,
      },
    });
    transaction.update(reference, {
      status: "handed_off",
      attemptCount: nextAttempt,
      currentMailId: nextMailId,
      handedOffAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      nextRetryAt: FieldValue.delete(),
    });
    return true;
  });
}

export const retryOrderNotifications = onSchedule("every 5 minutes", async () => {
  const snapshot = await adminDb.collection("notification_outbox")
    .where("status", "==", "retry_pending")
    .where("nextRetryAt", "<=", Timestamp.now())
    .orderBy("nextRetryAt", "asc")
    .limit(50)
    .get();
  const results = await Promise.allSettled(snapshot.docs.map((notification) => retryOrderNotification(notification.ref)));
  const retriedCount = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const failedCount = results.filter((result) => result.status === "rejected").length;
  if (retriedCount || failedCount) {
    appLogger.info("Order notification retry cycle completed.", { retriedCount, failedCount });
  }
});
