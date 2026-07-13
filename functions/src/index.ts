import { onRequest } from "firebase-functions/v2/https";
import { createApiApp } from "./api/app";
import { A2Z_SECRETS } from "./config/secrets";
export { syncReviewAggregates } from "./triggers/reviewAggregates";
export { scheduledSupplierSync } from "./scheduled/supplierSync";

export const api = onRequest({ cors: true, secrets: A2Z_SECRETS }, createApiApp());
