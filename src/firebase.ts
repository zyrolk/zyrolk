import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { reportClientIssue } from './services/observability/clientDiagnostics';
import { app, appCheckSiteKey, firebaseConfig } from './firebaseApp';

// These protected SDK services are imported only after main.tsx finishes the
// App Check bootstrap. Other modules continue consuming the same exports.
const auth = getAuth(app);
const db = getFirestore(app);

export { app, db, auth, firebaseConfig, appCheckSiteKey };

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
