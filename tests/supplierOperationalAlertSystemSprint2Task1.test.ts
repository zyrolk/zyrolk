import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  recordSupplierOperationalAlert,
  sanitizeSupplierAlertTechnicalMetadata,
  supplierOperationalAlertId,
  transitionSupplierOperationalAlert,
} from '../functions/src/api/suppliers/supplierOperationalAlerts';

type StoredDocument = Record<string, unknown>;
type DocumentReference = { collectionName: string; id: string; key: string };

const createFakeFirestore = (initial: Record<string, StoredDocument> = {}) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  const reference = (collectionName: string, id: string): DocumentReference => ({
    collectionName,
    id,
    key: `${collectionName}/${id}`,
  });
  const snapshot = (documentReference: DocumentReference) => ({
    exists: documents.has(documentReference.key),
    id: documentReference.id,
    data: () => documents.get(documentReference.key),
  });
  const db = {
    collection: (collectionName: string) => ({
      doc: (id: string) => reference(collectionName, id),
    }),
    runTransaction: async <T>(operation: (transaction: {
      get: (documentReference: DocumentReference) => Promise<ReturnType<typeof snapshot>>;
      set: (documentReference: DocumentReference, data: StoredDocument, options?: { merge?: boolean }) => void;
      create: (documentReference: DocumentReference, data: StoredDocument) => void;
    }) => Promise<T>) => operation({
      get: async (documentReference) => snapshot(documentReference),
      set: (documentReference, data, options) => {
        documents.set(documentReference.key, options?.merge
          ? { ...(documents.get(documentReference.key) || {}), ...data }
          : data);
      },
      create: (documentReference, data) => {
        if (documents.has(documentReference.key)) throw new Error(`Document ${documentReference.key} already exists.`);
        documents.set(documentReference.key, data);
      },
    }),
  };
  return { db, documents };
};

const collectionDocuments = (documents: Map<string, StoredDocument>, collectionName: string) => [...documents.entries()]
  .filter(([key]) => key.startsWith(`${collectionName}/`))
  .map(([, value]) => value);

test('critical supplier alert creation records the complete incident and triggers one email delivery', async () => {
  const now = Date.UTC(2026, 6, 29, 10, 0, 0);
  const { db, documents } = createFakeFirestore();
  const result = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_sync_failure',
    severity: 'critical',
    supplierId: 'supplier-a',
    jobId: 'job-a',
    batchId: 'batch-a',
    technicalMetadata: { classification: 'network', attempt: 3 },
    now,
  }, { notificationEmail: 'admin@zyro.lk' });

  assert.equal(result.created, true);
  assert.equal(result.notified, true);
  const alert = documents.get(`supplier_operational_alerts/${result.alertId}`)!;
  assert.equal(alert.alertId, result.alertId);
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.category, 'supplier_sync_failure');
  assert.equal(alert.supplierId, 'supplier-a');
  assert.equal(alert.jobId, 'job-a');
  assert.equal(alert.batchId, 'batch-a');
  assert.equal(alert.firstOccurrence, new Date(now).toISOString());
  assert.equal(alert.lastOccurrence, new Date(now).toISOString());
  assert.equal(alert.status, 'open');
  assert.equal(alert.assignedAdmin, null);
  assert.match(String(alert.message), /synchronization failed/iu);
  assert.deepEqual(alert.technicalMetadata, { classification: 'network', attempt: 3 });
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events').length, 1);
  assert.equal(collectionDocuments(documents, 'notification_outbox').length, 1);
  assert.equal(collectionDocuments(documents, 'mail').length, 1);
});

test('duplicate active alerts update occurrence time without creating unlimited alerts or notifications', async () => {
  const firstAt = Date.UTC(2026, 6, 29, 10, 0, 0);
  const secondAt = firstAt + 60_000;
  const { db, documents } = createFakeFirestore();
  const input = {
    category: 'dead_letter_created' as const,
    severity: 'critical' as const,
    supplierId: 'supplier-a',
    queueItemId: 'queue-a',
  };
  const first = await recordSupplierOperationalAlert(db as never, { ...input, now: firstAt }, { notificationEmail: 'admin@zyro.lk' });
  const duplicate = await recordSupplierOperationalAlert(db as never, {
    ...input,
    now: secondAt,
    technicalMetadata: { retryCount: 5 },
  }, { notificationEmail: 'admin@zyro.lk' });

  assert.equal(duplicate.alertId, first.alertId);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.notified, false);
  const alert = documents.get(`supplier_operational_alerts/${first.alertId}`)!;
  assert.equal(alert.firstOccurrence, new Date(firstAt).toISOString());
  assert.equal(alert.lastOccurrence, new Date(secondAt).toISOString());
  assert.equal(alert.occurrenceCount, 2);
  assert.deepEqual(alert.technicalMetadata, { retryCount: 5 });
  assert.equal(collectionDocuments(documents, 'supplier_operational_alerts').length, 1);
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events').length, 1);
  assert.equal(collectionDocuments(documents, 'mail').length, 1);
});

test('acknowledgement and resolution preserve immutable lifecycle history and a later incident reopens safely', async () => {
  const now = Date.UTC(2026, 6, 29, 10, 0, 0);
  const { db, documents } = createFakeFirestore();
  const created = await recordSupplierOperationalAlert(db as never, {
    category: 'queue_worker_failure',
    severity: 'critical',
    dedupeScope: 'supplier-review-worker',
    now,
  }, { notificationEmail: 'admin@zyro.lk' });
  const actor = { uid: 'admin-user', email: 'admin@zyro.lk' };

  const acknowledged = await transitionSupplierOperationalAlert(db as never, created.alertId, 'acknowledged', actor, now + 1_000);
  assert.equal(acknowledged?.status, 'acknowledged');
  assert.deepEqual(acknowledged?.assignedAdmin, actor);
  const resolved = await transitionSupplierOperationalAlert(db as never, created.alertId, 'resolved', actor, now + 2_000);
  assert.equal(resolved?.status, 'resolved');
  const reopened = await recordSupplierOperationalAlert(db as never, {
    category: 'queue_worker_failure',
    severity: 'critical',
    dedupeScope: 'supplier-review-worker',
    now: now + 3_000,
  }, { notificationEmail: 'admin@zyro.lk' });

  assert.equal(reopened.reopened, true);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.notified, true);
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events').length, 4);
  assert.equal(collectionDocuments(documents, 'mail').length, 2);
});

test('supplier alert identity isolates simultaneous supplier failures while suppressing repeats per supplier', async () => {
  const { db, documents } = createFakeFirestore();
  const first = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'supplier-a',
  });
  const second = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'supplier-b',
  });
  await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'supplier-a',
  });

  assert.notEqual(first.alertId, second.alertId);
  assert.equal(collectionDocuments(documents, 'supplier_operational_alerts').length, 2);
  assert.equal(documents.get(`supplier_operational_alerts/${first.alertId}`)?.occurrenceCount, 2);
  assert.equal(documents.get(`supplier_operational_alerts/${second.alertId}`)?.occurrenceCount, 1);
});

test('queue, scheduler, media, storage, authentication, and App Check failures retain independent alert identities', () => {
  const categories = [
    'dead_letter_created',
    'queue_age_threshold_exceeded',
    'queue_worker_failure',
    'scheduler_failure',
    'media_processing_failure',
    'storage_failure',
    'authentication_failure',
    'app_check_failure',
  ] as const;
  const ids = categories.map((category) => supplierOperationalAlertId({ category, dedupeScope: 'same-scope' }));
  assert.equal(new Set(ids).size, categories.length);
});

test('technical alert metadata strips credentials and bounds nested diagnostics', () => {
  assert.deepEqual(sanitizeSupplierAlertTechnicalMetadata({
    reason: 'safe failure',
    password: 'do-not-store',
    Authorization: 'Bearer secret',
    nested: { token: 'hidden', status: 500 },
  }), {
    reason: 'safe failure',
    nested: { status: 500 },
  });
});

test('required failure producers use the shared alert engine and lifecycle remains Functions-authoritative', () => {
  const app = readFileSync('functions/src/api/app.ts', 'utf8');
  const auth = readFileSync('functions/src/api/middleware/supplierHubAdminAuth.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const dispatcher = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const queueWorker = readFileSync('functions/src/scheduled/supplierQueueWorker.ts', 'utf8');
  const media = readFileSync('functions/src/api/suppliers/supplierMediaPipeline.ts', 'utf8');
  const monitor = readFileSync('functions/src/scheduled/supplierOperationalAlerts.ts', 'utf8');
  const rules = readFileSync('firestore.rules', 'utf8');
  const index = readFileSync('functions/src/index.ts', 'utf8');

  assert.match(app, /category: "app_check_failure"/u);
  assert.match(auth, /category: "authentication_failure"/u);
  assert.match(routes, /category: "supplier_connection_failure"/u);
  assert.match(sync, /category: "supplier_sync_failure"/u);
  assert.match(dispatcher, /category: "scheduler_failure"/u);
  assert.match(queue, /category: "dead_letter_created"/u);
  assert.match(queueWorker, /category: "queue_worker_failure"/u);
  assert.match(media, /category: "storage_failure"/u);
  assert.match(monitor, /queue_age_threshold_exceeded/u);
  assert.match(index, /scheduledSupplierOperationalAlerts/u);
  assert.match(routes, /supplier-operations\/alerts\/:alertId\/action/u);
  assert.match(rules, /match \/supplier_operational_alerts\/\{docId\}[\s\S]*?allow create, update, delete: if false/u);
  assert.match(rules, /match \/supplier_operational_alert_events\/\{docId\}[\s\S]*?allow create, update, delete: if false/u);
});
