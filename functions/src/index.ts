import { onRequest } from "firebase-functions/v2/https";
import { createApiApp } from "./api/app";

export const api = onRequest({ cors: true }, createApiApp());
