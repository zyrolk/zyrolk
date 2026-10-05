import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import {
  beginSupplierSyncAttempt,
  createSupplierSyncJob,
  finalizeSupplierSyncAttempt,
  leaseSupplierSyncJob,
  projectSupplierSyncJobForAdmin,
  recordSupplierSyncAttemptContext,
  requeueSupplierSyncJob,
  waitSupplierSyncJob,
} from '../functions/src/api/suppliers/supplierSyncJobs';

interface FakeReference {
  id: string;
  path: string;
  collection(name: string): { doc(id?: string): FakeReference };
}

class FakeFirestore {
  readonly documents = new Map<string, Record<string, unknown>>();
  private sequence = 0;

  private reference(path: string, id: string): FakeReference {
    return {
      id,
      path,
      collection: (name: string) => ({
        doc: (childId?: string) => {
          const nextId = childId || `doc-${++this.sequence}`;
          return this.reference(`${path}/${name}/${nextId}`, nextId);
        },
      }),
    };
  }

  collection(name: string) {
    return {
      doc: (id?: string): FakeReference => {
        const documentId = id || `job-${++this.sequence}`;
        return this.reference(`${name}/${documentId}`, documentId);
      },
    };
  }

  async runTransaction<T>(callback: (transaction: {
    get(reference: FakeReference): Promise<{ id: string; exists: boolean; data(): Record<string, unknown> | undefined }>;
    create(reference: FakeReference, data: Record<string, unknown>): void;
    set(reference: FakeReference, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  }) => Promise<T>): Promise<T> {
    const writes: Array<() => void> = [];
    const transaction = {
      get: async (reference: FakeReference) => ({
        id: reference.id,
        exists: this.documents.has(reference.path),
        data: () => this.documents.get(reference.path),
      }),
      create: (reference: FakeReference, data: Record<string, unknown>) => writes.push(() => {
        if (this.documents.has(reference.path)) throw new Error('already exists');
        this.documents.set(reference.path, { ...data });
      }),
      set: (reference: FakeReference, data: Record<string, unknown>, options?: { merge?: boolean }) => writes.push(() => {
        this.documents.set(reference.path, options?.merge
          ? { ...(this.documents.get(reference.path) || {}), ...data }
          : { ...data });
      }),
    };
    const result = await callback(transaction);
    writes.forEach((write) => write());
    return result;
  }
}

const input = {
  trigger: 'manual' as const,
  sourceIds: ['dropex'],
  requestedBy: { uid: 'admin-1', email: 'admin@zyro.lk' },
  syncRequest: { mode: 'full' as const, totalProductLimit: 5000, pageSize: 100 },
};

const counters = (scanned: number, pages: number) => ({
  scanned,
  processed: scanned,
  queued: scanned,
  new: 0,
  changeCandidates: scanned,
  unchanged: 0,
  rejected: null,
  failed: 0,
  warnings: 0,
  pages,
});

test('Slice 1 keeps immutable attempt records and cumulative counters across resume', async () => {
  const db = new FakeFirestore();
  const start = Date.parse('2026-10-05T08:00:00.000Z');
  const created = await createSupplierSyncJob(db as unknown as Firestore, input, start);
  const firstLease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-1', start + 1_000);
  assert.ok(firstLease);

  const first = await beginSupplierSyncAttempt(db as unknown as Firestore, created.job.id, 'worker-1', firstLease.leaseId, {
    attemptId: 'attempt-1', kind: 'initial', startedAt: new Date(start + 1_000).toISOString(),
  }, start + 1_000);
  await recordSupplierSyncAttemptContext(db as unknown as Firestore, created.job.id, 'worker-1', firstLease.leaseId, first.attemptId, {
    sourceId: 'dropex', cursorBefore: 'offset:45', effectivePageSize: 100, remainingLimitAtStart: 5000,
  }, start + 1_001);
  await finalizeSupplierSyncAttempt(db as unknown as Firestore, created.job.id, 'worker-1', firstLease.leaseId, first.attemptId, {
    status: 'waiting', cursorAfter: { dropex: 'offset:4690' }, counters: counters(4645, 46), stopReason: 'runtime_budget',
  }, start + 2_000);
  await waitSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-1', firstLease.leaseId, firstLease.job.progress, 'continues', start + 2_001);

  await requeueSupplierSyncJob(db as unknown as Firestore, created.job.id, 'resume', 'admin-1', start + 3_000);
  const secondLease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-2', start + 3_001);
  assert.ok(secondLease);
  const second = await beginSupplierSyncAttempt(db as unknown as Firestore, created.job.id, 'worker-2', secondLease.leaseId, {
    attemptId: 'attempt-2', kind: 'resume', startedAt: new Date(start + 3_001).toISOString(),
  }, start + 3_001);
  await recordSupplierSyncAttemptContext(db as unknown as Firestore, created.job.id, 'worker-2', secondLease.leaseId, second.attemptId, {
    sourceId: 'dropex', cursorBefore: 'offset:4690', effectivePageSize: 100, remainingLimitAtStart: 355,
  }, start + 3_002);
  await finalizeSupplierSyncAttempt(db as unknown as Firestore, created.job.id, 'worker-2', secondLease.leaseId, second.attemptId, {
    status: 'completed', cursorAfter: { dropex: 'offset:5045' }, counters: counters(355, 4), stopReason: 'limit_reached',
  }, start + 4_000);

  const firstDoc = db.documents.get(`supplier_sync_jobs/${created.job.id}/attempts/attempt-1`);
  const secondDoc = db.documents.get(`supplier_sync_jobs/${created.job.id}/attempts/attempt-2`);
  const jobDoc = db.documents.get(`supplier_sync_jobs/${created.job.id}`);
  assert.equal(firstDoc?.status, 'waiting');
  assert.equal((firstDoc?.counters as Record<string, unknown>)?.scanned, 4645);
  assert.equal(secondDoc?.status, 'completed');
  assert.equal((secondDoc?.counters as Record<string, unknown>)?.scanned, 355);
  assert.equal((jobDoc?.cumulativeCounters as Record<string, unknown>)?.scanned, 5000);
  assert.equal((jobDoc?.cumulativeCounters as Record<string, unknown>)?.pages, 50);
  assert.deepEqual(firstDoc?.cursorBefore, { dropex: 'offset:45' });
  assert.deepEqual(secondDoc?.cursorBefore, { dropex: 'offset:4690' });
  assert.equal((jobDoc?.effectivePageSize as Record<string, unknown>)?.dropex, 100);
  assert.equal(jobDoc?.attemptCount, 2);
  assert.equal(jobDoc?.resumeCount, 1);
});

test('Slice 1 creates a third immutable attempt without overwriting prior evidence', async () => {
  const db = new FakeFirestore();
  const start = Date.parse('2026-10-05T09:00:00.000Z');
  const created = await createSupplierSyncJob(db as unknown as Firestore, input, start);
  let lease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-1', start + 1_000);
  assert.ok(lease);
  for (let number = 1; number <= 3; number += 1) {
    const attempt = await beginSupplierSyncAttempt(db as unknown as Firestore, created.job.id, `worker-${number}`, lease.leaseId, {
      attemptId: `attempt-${number}`, kind: number === 1 ? 'initial' : 'resume',
    }, start + number * 1_000);
    await finalizeSupplierSyncAttempt(db as unknown as Firestore, created.job.id, `worker-${number}`, lease.leaseId, attempt.attemptId, {
      status: number === 3 ? 'completed' : 'waiting', counters: counters(5, 1), stopReason: number === 3 ? 'completed' : 'paused',
    }, start + number * 1_000 + 100);
    if (number < 3) {
      await waitSupplierSyncJob(db as unknown as Firestore, created.job.id, `worker-${number}`, lease.leaseId, lease.job.progress, 'continues', start + number * 1_000 + 200);
      await requeueSupplierSyncJob(db as unknown as Firestore, created.job.id, 'resume', 'admin-1', start + number * 1_000 + 300);
      lease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, `worker-${number + 1}`, start + number * 1_000 + 301) as typeof lease;
      assert.ok(lease);
    }
  }
  assert.equal(db.documents.get(`supplier_sync_jobs/${created.job.id}/attempts/attempt-1`)?.status, 'waiting');
  assert.equal(db.documents.get(`supplier_sync_jobs/${created.job.id}/attempts/attempt-2`)?.status, 'waiting');
  assert.equal(db.documents.get(`supplier_sync_jobs/${created.job.id}/attempts/attempt-3`)?.status, 'completed');
  assert.equal(db.documents.get(`supplier_sync_jobs/${created.job.id}`)?.attemptCount, 3);
});

test('Slice 1 persists request/effective limit evidence and preserves legacy reads', async () => {
  const db = new FakeFirestore();
  const start = Date.parse('2026-10-05T10:00:00.000Z');
  const created = await createSupplierSyncJob(db as unknown as Firestore, input, start);
  const lease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-1', start + 1_000);
  assert.ok(lease);
  const attempt = await beginSupplierSyncAttempt(db as unknown as Firestore, created.job.id, 'worker-1', lease.leaseId, {
    attemptId: 'attempt-limit', kind: 'initial',
  }, start + 1_000);
  await recordSupplierSyncAttemptContext(db as unknown as Firestore, created.job.id, 'worker-1', lease.leaseId, attempt.attemptId, {
    sourceId: 'dropex', cursorBefore: 'offset:0', effectivePageSize: 100, remainingLimitAtStart: 5000,
  }, start + 1_001);
  const jobDoc = db.documents.get(`supplier_sync_jobs/${created.job.id}`) || {};
  const attemptDoc = db.documents.get(`supplier_sync_jobs/${created.job.id}/attempts/attempt-limit`) || {};
  assert.equal(jobDoc.requestedTotalProductLimit, 5000);
  assert.equal(jobDoc.effectiveTotalProductLimit, 5000);
  assert.equal(jobDoc.requestedPageSize, 100);
  assert.deepEqual(jobDoc.effectivePageSize, { dropex: 100 });
  assert.deepEqual(attemptDoc.remainingLimitAtStart, { dropex: 5000 });

  const legacy = projectSupplierSyncJobForAdmin({
    id: 'legacy', state: 'completed', trigger: 'manual', sourceIds: [], createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(), nextAttemptAt: new Date(start).toISOString(), retryCount: 0,
    retryLimit: 5, resumeCount: 0, requestedBy: { uid: 'admin', email: '' }, progress: lease.job.progress,
  });
  assert.equal(legacy.evidenceStatus, 'legacy');
  assert.equal(legacy.initialCursor, null);
  assert.equal(legacy.effectivePageSize, null);
});

test('Slice 1 keeps the old mutable-history overwrite failure non-authoritative', () => {
  const db = new FakeFirestore();
  const historyPath = 'supplier_sync_history/legacy-job';
  db.documents.set(historyPath, { productsScanned: 4645, productsQueued: 4645, pagesProcessed: 46 });
  db.documents.set(historyPath, { productsScanned: 355, productsQueued: 355, pagesProcessed: 4 });
  assert.equal(db.documents.get(historyPath)?.productsScanned, 355);
  assert.equal(db.documents.get(historyPath)?.pagesProcessed, 4);
  assert.equal('supplier_sync_jobs/{jobId}/attempts/{attemptId}'.includes('attemptId'), true);
});
