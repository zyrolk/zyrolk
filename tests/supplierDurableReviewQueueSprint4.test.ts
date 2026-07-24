import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierQueueFailureUpdate,
  buildSupplierQueueLifecycle,
  canLeaseSupplierQueueItem,
  classifySupplierQueueFailure,
  isSupplierQueueLeaseExpired,
  leaseSupplierReviewQueueItem,
  processSupplierReviewQueueItem,
  recoverExpiredSupplierReviewQueueLeases,
  retryDeadLetterSupplierReviewQueueItem,
} from '../functions/src/scheduled/supplierReviewQueue';

type StoredDocument = Record<string, unknown>;

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  let generatedId = 0;
  const reference = (collectionName: string, id: string) => ({ collectionName, id, key: `${collectionName}/${id}` });
  const snapshot = (ref: ReturnType<typeof reference>) => ({
    exists: documents.has(ref.key),
    data: () => documents.get(ref.key),
  });
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => reference(collectionName, id || `generated-${++generatedId}`),
      where: () => {
        const query = {
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          get: async () => ({
            docs: [...documents.entries()]
              .filter(([key]) => key.startsWith(`${collectionName}/`))
              .map(([key, data]) => ({ id: key.slice(collectionName.length + 1), data: () => data })),
          }),
        };
        return query;
      },
    }),
    runTransaction: async <T>(operation: (transaction: {
      get: (ref: ReturnType<typeof reference>) => Promise<ReturnType<typeof snapshot>>;
      set: (ref: ReturnType<typeof reference>, data: StoredDocument, options?: { merge?: boolean }) => void;
      create: (ref: ReturnType<typeof reference>, data: StoredDocument) => void;
      delete: (ref: ReturnType<typeof reference>) => void;
    }) => Promise<T>) => operation({
      get: async (ref) => snapshot(ref),
      set: (ref, data, options) => {
        documents.set(ref.key, options?.merge ? { ...(documents.get(ref.key) || {}), ...data } : data);
      },
      create: (ref, data) => {
        if (documents.has(ref.key)) throw new Error('Audit event already exists');
        documents.set(ref.key, data);
      },
      delete: (ref) => documents.delete(ref.key),
    }),
  };
  return { db, documents };
};

test('canonical review queue lifecycle supports lease acquisition, duplicate-worker exclusion, and expired-lease recovery', async () => {
  const now = Date.now();
  const { db, documents } = createFakeFirestore({
    'supplier_review_queue/review-1': { id: 'review-1', ...buildSupplierQueueLifecycle(new Date(now - 1).toISOString()) },
  });
  const initial = documents.get('supplier_review_queue/review-1')!;
  assert.equal(canLeaseSupplierQueueItem(initial, now), true);
  await leaseSupplierReviewQueueItem(db as never, 'review-1', 'worker-a', now);
  const leased = documents.get('supplier_review_queue/review-1')!;
  assert.equal(leased.queueState, 'leased');
  assert.equal(leased.leaseOwner, 'worker-a');
  assert.equal(await leaseSupplierReviewQueueItem(db as never, 'review-1', 'worker-b', now), null);
  const expired = { ...leased, leaseExpiresAt: new Date(now - 1).toISOString() };
  assert.equal(isSupplierQueueLeaseExpired(expired, now), true);
  assert.equal(canLeaseSupplierQueueItem(expired, now), true);
  documents.set('supplier_review_queue/review-1', expired);
  assert.equal(await leaseSupplierReviewQueueItem(db as never, 'review-1', 'stale-worker', now), null);
  assert.equal(documents.get('supplier_review_queue/review-1')?.queueState, 'retryable_failure');
});

test('retry backoff is bounded and terminal failures become durable dead letters', () => {
  const now = Date.now();
  const firstFailure = buildSupplierQueueFailureUpdate({ retryCount: 0, retryLimit: 2 }, new Error('socket timeout'), now);
  assert.equal(firstFailure.state, 'retryable_failure');
  assert.equal(firstFailure.data.retryCount, 1);
  assert.ok(Date.parse(String(firstFailure.data.nextRetryAt)) > now);

  const finalFailure = buildSupplierQueueFailureUpdate({ retryCount: 1, retryLimit: 2 }, new Error('socket timeout'), now);
  assert.equal(finalFailure.state, 'dead_letter');
  assert.equal(finalFailure.data.failureClassification, 'network');
  assert.equal(finalFailure.data.deadLetteredAt !== undefined, true);
  assert.equal(classifySupplierQueueFailure(new Error('Supplier URL resolves to a blocked network address.')), 'security');
  assert.equal(classifySupplierQueueFailure(new Error('Category is required.')), 'validation');
});

test('worker completion materializes compatible queue documents and dead letters can be safely retried', async () => {
  const now = Date.now();
  const { db, documents } = createFakeFirestore({
    'supplier_review_queue/review-2': {
      id: 'review-2',
      status: 'Pending',
      sourceId: 'supplier-a',
      ...buildSupplierQueueLifecycle(new Date(now - 1).toISOString()),
      importPayload: { id: 'review-2', importStatus: 'Pending' },
      pendingChangePayload: { id: 'change-review-2', status: 'Pending' },
    },
    'supplier_review_queue/review-3': { id: 'review-3', queueState: 'dead_letter', retryCount: 5 },
  });
  const result = await processSupplierReviewQueueItem(db as never, 'review-2', 'worker-a', now);
  assert.deepEqual(result, { queueItemId: 'review-2', outcome: 'completed', state: 'review_pending' });
  assert.equal(documents.get('supplier_review_queue/review-2')?.queueState, 'review_pending');
  assert.equal(documents.get('supplier_import_queue/review-2')?.importStatus, 'Pending');
  assert.equal(documents.get('supplier_pending_changes/change-review-2')?.status, 'Pending');
  assert.equal(await retryDeadLetterSupplierReviewQueueItem(db as never, 'review-3', now), true);
  assert.equal(documents.get('supplier_review_queue/review-3')?.queueState, 'queued');
  const auditEvents = [...documents.entries()].filter(([key]) => key.startsWith('supplier_approval_audit/')).map(([, data]) => data);
  assert.equal(auditEvents.some((event) => event.action === 'leased'), true);
  assert.equal(auditEvents.some((event) => event.action === 'processing'), true);
  assert.equal(auditEvents.some((event) => event.action === 'review_pending'), true);
  assert.equal(auditEvents.some((event) => event.action === 'retry'), true);
});

test('expired leases are recovered exactly once by the recovery worker', async () => {
  const now = Date.now();
  const { db, documents } = createFakeFirestore({
    'supplier_review_queue/review-stale': {
      id: 'review-stale', queueState: 'processing', leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date(now - 1).toISOString(), retryCount: 0, retryLimit: 3,
    },
  });
  assert.equal(await recoverExpiredSupplierReviewQueueLeases(db as never, now), 1);
  assert.equal(documents.get('supplier_review_queue/review-stale')?.queueState, 'retryable_failure');
  assert.equal(await recoverExpiredSupplierReviewQueueLeases(db as never, now), 0);
});

test('scheduled sync, admin recovery, and approval paths preserve the durable review queue contract', () => {
  const scheduled = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');

  assert.match(scheduled, /buildSupplierQueueLifecycle/);
  assert.match(scheduled, /processSupplierReviewQueueItem/);
  assert.doesNotMatch(scheduled, /recoverExpiredSupplierReviewQueueLeases/);
  assert.match(readFileSync('functions/src/scheduled/supplierQueueWorker.ts', 'utf8'), /recoverExpiredSupplierReviewQueueLeases/);
  assert.match(routes, /supplier-review-queue\/:queueItemId\/retry", requireSupplierHubAdmin/);
  assert.match(routes, /supplier-review-queue\/resume", requireSupplierHubAdmin/);
  assert.match(approval, /const terminalState = action === "approved" \? "approved"/);
  assert.doesNotMatch(approval, /transaction\.delete\(reviewReference\)/);
  assert.match(portal, /queueState: "review_pending"/);
});
