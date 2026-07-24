import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getAppCheck } from "firebase-admin/app-check";

if (getApps().length === 0) {
  // Cloud Functions supplies GCLOUD_PROJECT. The explicit local fallback keeps
  // Admin Auth token audience validation aligned with the web Firebase app when
  // the modular API is loaded by server.ts outside the Functions runtime.
  const projectId = process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.FIREBASE_PROJECT_ID
    || "zyrolk-e0164";
  initializeApp({ projectId });
}

export const adminDb = getFirestore();
export const adminAuth = getAuth();
export const adminAppCheck = getAppCheck();
