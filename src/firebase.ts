import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import appletConfig from '../firebase-applet-config.json';
import { reportClientIssue } from './services/observability/clientDiagnostics';

// Construct config directly from the imported JSON, with absolutely no hardcoded values
const firebaseConfig = {
  apiKey: appletConfig.apiKey,
  authDomain: appletConfig.authDomain,
  projectId: appletConfig.projectId,
  storageBucket: appletConfig.storageBucket,
  messagingSenderId: appletConfig.messagingSenderId,
  appId: appletConfig.appId
};

// Reuse the initialized app during development refreshes and production module reuse.
const app = getApps()[0] || initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { db, auth, firebaseConfig };

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
  reportClientIssue('firestore-operation-failed', { code, operationType, path });

  const message = code === 'permission-denied'
    ? 'You do not have permission to complete this action.'
    : code === 'unavailable' || code === 'failed-precondition'
      ? 'This service is temporarily unavailable. Please try again.'
      : 'The requested data operation could not be completed.';
  const safeError = new Error(message);
  safeError.name = 'FirestoreOperationError';
  throw safeError;
}

export default app;
