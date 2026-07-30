import { onRequest } from "firebase-functions/v2/https";
import { createApiApp } from "./api/app";
import { API_SECRETS } from "./config/secrets";
export { syncReviewAggregates } from "./triggers/reviewAggregates";
export { scheduledSupplierSync } from "./scheduled/supplierSync";
export { scheduledSupplierSyncJobDispatcher, supplierSyncJobCreated } from "./scheduled/supplierSyncWorker";
export { scheduledSupplierQueueWorker } from "./scheduled/supplierQueueWorker";
export { scheduledSupplierOperationalAlerts } from "./scheduled/supplierOperationalAlerts";
export { expirePaymentReservations } from "./scheduled/paymentReservations";
export { sendOrderNotifications, trackOrderNotificationDelivery } from "./triggers/orderNotifications";
export { retryOrderNotifications } from "./scheduled/orderNotificationRetries";

export const api = onRequest({
  cors: false,
  secrets: API_SECRETS,
  timeoutSeconds: 300,
  memory: "1GiB",
}, createApiApp());
