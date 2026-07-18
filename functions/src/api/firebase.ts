import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getAppCheck } from "firebase-admin/app-check";

if (getApps().length === 0) {
  initializeApp();
}

export const adminDb = getFirestore();
export const adminAuth = getAuth();
export const adminAppCheck = getAppCheck();
