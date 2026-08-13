import { getApps, initializeApp } from 'firebase/app';
import appletConfig from '../firebase-applet-config.json';

// Construct config directly from the imported JSON, with absolutely no hardcoded values.
export const firebaseConfig = {
  apiKey: appletConfig.apiKey,
  authDomain: appletConfig.authDomain,
  projectId: appletConfig.projectId,
  storageBucket: appletConfig.storageBucket,
  messagingSenderId: appletConfig.messagingSenderId,
  appId: appletConfig.appId,
  measurementId: appletConfig.measurementId
    || (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_FIREBASE_MEASUREMENT_ID,
};

// A reCAPTCHA Enterprise site key is public, domain-restricted configuration.
// Keep the checked-in production value as the Firebase Hosting default while
// allowing staging builds to override it explicitly.
export const appCheckSiteKey = String(
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_FIREBASE_APP_CHECK_SITE_KEY
  || appletConfig.appCheckSiteKey
  || '',
).trim();

// App Check must receive the Firebase App before Auth/Firestore are created.
export const app = getApps()[0] || initializeApp(firebaseConfig);

export default app;
