import { onRequest } from "firebase-functions/v2/https";
import { createApiApp } from "./api/app";
import { API_SECRETS } from "./config/secrets";
export { syncReviewAggregates } from "./triggers/reviewAggregates";
export { scheduledSupplierSync } from "./scheduled/supplierSync";
export { scheduledSupplierQueueWorker } from "./scheduled/supplierQueueWorker";
export { expirePaymentReservations } from "./scheduled/paymentReservations";
export { sendOrderNotifications } from "./triggers/orderNotifications";

export const api = onRequest({
  cors: false,
  secrets: API_SECRETS,
  timeoutSeconds: 300,
  memory: "1GiB",
}, createApiApp());
