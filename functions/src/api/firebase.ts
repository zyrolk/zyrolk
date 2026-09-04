import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAppCheck } from "firebase-admin/app-check";

if (getApps().length === 0) {
  // Cloud Functions supplies GCLOUD_PROJECT. The explicit local fallback keeps
  // Admin Auth token audience validation aligned with the web Firebase app when
  // the modular API is loaded by server.ts outside the Functions runtime.
  const projectId = process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.FIREBASE_PROJECT_ID
    || "zyrolk-e0164";
  const firebaseConfig = (() => {
    try {
      const parsed = JSON.parse(String(process.env.FIREBASE_CONFIG || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  })();
  const storageBucket = typeof firebaseConfig.storageBucket === "string" && firebaseConfig.storageBucket.trim().length > 0
    ? firebaseConfig.storageBucket.trim()
    : `${projectId}.firebasestorage.app`;
  initializeApp({ projectId, storageBucket });
}

export const adminDb = getFirestore();
export const adminAuth = getAuth();
export const adminAppCheck = getAppCheck();
export { FieldValue };
