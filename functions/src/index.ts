import { onRequest } from "firebase-functions/v2/https";
import { createApiApp } from "./api/app";
export { syncReviewAggregates } from "./triggers/reviewAggregates";

export const api = onRequest({ cors: true }, createApiApp());
