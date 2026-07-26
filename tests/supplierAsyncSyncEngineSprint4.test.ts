import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import {
  calculateSupplierSyncJobProgress,
  canLeaseSupplierSyncJob,
  canTransitionSupplierSyncJob,
  createSupplierSyncJob,
  failSupplierSyncJob,
  heartbeatSupplierSyncJob,
  leaseSupplierSyncJob,
  requeueSupplierSyncJob,
  requestSupplierSyncJobCancellation,
  SUPPLIER_SYNC_JOB_STATES,
} from '../functions/src/api/suppliers/supplierSyncJobs';
import { isLocalSupplierSyncWorkerRuntime } from '../functions/src/scheduled/supplierSyncWorker';

interface FakeReference { id: string; path: string }

class FakeFirestore {
  readonly documents = new Map<string, Record<string, unknown>>();
  private sequence = 0;

  collection(name: string) {
    return {
      doc: (id?: string): FakeReference => {
        const documentId = id || `job-${++this.sequence}`;
        return { id: documentId, path: `${name}/${documentId}` };
      },
    };
  }

  seed(path: string, data: Record<string, unknown>): void {
    this.documents.set(path, { ...data });
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

test('Sprint 4 defines the canonical asynchronous sync lifecycle and valid transitions', () => {
  assert.deepEqual(SUPPLIER_SYNC_JOB_STATES, ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
  assert.equal(canTransitionSupplierSyncJob('pending', 'running'), true);
  assert.equal(canTransitionSupplierSyncJob('running', 'waiting'), true);
  assert.equal(canTransitionSupplierSyncJob('running', 'completed'), true);
  assert.equal(canTransitionSupplierSyncJob('running', 'cancelled'), true);
  assert.equal(canTransitionSupplierSyncJob('completed', 'running'), false);
});

test('Sprint 4 local preview may execute jobs without creating a second production authority', () => {
  assert.equal(isLocalSupplierSyncWorkerRuntime({ NODE_ENV: 'development' }), true);
  assert.equal(isLocalSupplierSyncWorkerRuntime({ NODE_ENV: 'production' }), false);
  assert.equal(isLocalSupplierSyncWorkerRuntime({ NODE_ENV: 'development', K_SERVICE: 'api' }), false);
  assert.equal(isLocalSupplierSyncWorkerRuntime({ NODE_ENV: 'development', FUNCTION_TARGET: 'api' }), false);
});

test('Sprint 4 creates a durable job, leases it once, heartbeats it, and cooperatively cancels it', async () => {
  const db = new FakeFirestore();
  const now = Date.parse('2026-07-26T08:00:00.000Z');
  const created = await createSupplierSyncJob(db as unknown as Firestore, {
    trigger: 'manual',
    sourceIds: ['a2z-traders'],
    requestedBy: { uid: 'admin-1', email: 'admin@zyro.lk' },
  }, now);
  assert.equal(created.created, true);
  assert.equal(created.job.state, 'pending');
  assert.equal(canLeaseSupplierSyncJob(created.job, now), true);

  const lease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-a', now);
  assert.ok(lease);
  assert.equal(await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-b', now), null);

  const progress = calculateSupplierSyncJobProgress(now, {
    phase: 'catalog_traversal', totalSources: 2, completedSources: 1, productsScanned: 100,
  }, now + 60_000);
  const firstHeartbeat = await heartbeatSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-a', lease.leaseId, progress, now + 60_000);
  assert.equal(firstHeartbeat.cancellationRequested, false);
  await requestSupplierSyncJobCancellation(db as unknown as Firestore, created.job.id, 'admin-1', now + 61_000);
  const secondHeartbeat = await heartbeatSupplierSyncJob(db as unknown as Firestore, created.job.id, 'worker-a', lease.leaseId, progress, now + 62_000);
  assert.equal(secondHeartbeat.cancellationRequested, true);
});

test('Sprint 4 supports resume and retry without making terminal jobs directly leaseable', async () => {
  const db = new FakeFirestore();
  const now = Date.parse('2026-07-26T08:00:00.000Z');
  db.seed('supplier_sync_jobs/cancelled-job', {
    id: 'cancelled-job', state: 'cancelled', trigger: 'manual', sourceIds: [], createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(), nextAttemptAt: new Date(now).toISOString(), retryCount: 0, retryLimit: 5,
    resumeCount: 0, requestedBy: { uid: 'admin-1', email: '' }, progress: calculateSupplierSyncJobProgress(now, {}, now),
  });
  db.seed('supplier_sync_jobs/failed-job', {
    id: 'failed-job', state: 'failed', trigger: 'manual', sourceIds: [], createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(), nextAttemptAt: new Date(now).toISOString(), retryCount: 5, retryLimit: 5,
    resumeCount: 0, requestedBy: { uid: 'admin-1', email: '' }, progress: calculateSupplierSyncJobProgress(now, {}, now),
  });
  assert.equal(canLeaseSupplierSyncJob(db.documents.get('supplier_sync_jobs/failed-job') || {}, now), false);
  assert.equal((await requeueSupplierSyncJob(db as unknown as Firestore, 'cancelled-job', 'resume', 'admin-1', now))?.state, 'pending');
  assert.equal((await requeueSupplierSyncJob(db as unknown as Firestore, 'failed-job', 'retry', 'admin-1', now))?.state, 'pending');
});

test('Sprint 4 automatic failures use bounded retry attempts instead of retrying forever', async () => {
  const db = new FakeFirestore();
  const start = Date.parse('2026-07-26T08:00:00.000Z');
  const created = await createSupplierSyncJob(db as unknown as Firestore, { trigger: 'manual' }, start);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const now = start + attempt * 20 * 60_000;
    const record = db.documents.get(`supplier_sync_jobs/${created.job.id}`) || {};
    if (record.state === 'waiting') record.nextAttemptAt = new Date(now).toISOString();
    const lease = await leaseSupplierSyncJob(db as unknown as Firestore, created.job.id, `worker-${attempt}`, now);
    assert.ok(lease);
    await failSupplierSyncJob(
      db as unknown as Firestore,
      created.job.id,
      `worker-${attempt}`,
      lease.leaseId,
      calculateSupplierSyncJobProgress(start, { phase: 'catalog_traversal' }, now),
      new Error('transient connector failure'),
      now,
    );
  }
  const finalRecord = db.documents.get(`supplier_sync_jobs/${created.job.id}`) || {};
  assert.equal(finalRecord.state, 'failed');
  assert.equal(finalRecord.retryCount, 5);
});

test('Sprint 4 progress provides bounded completion and ETA', () => {
  const start = Date.parse('2026-07-26T08:00:00.000Z');
  const progress = calculateSupplierSyncJobProgress(start, {
    phase: 'catalog_traversal', totalSources: 4, completedSources: 1, pagesProcessed: 10,
  }, start + 60_000);
  assert.equal(progress.percent, 25);
  assert.equal(progress.etaMs, 180_000);
  assert.equal(progress.pagesProcessed, 10);
  assert.equal(calculateSupplierSyncJobProgress(start, { phase: 'completed', totalSources: 4, completedSources: 4 }, start + 120_000).percent, 100);
});

test('Sprint 4 routes all callers through the durable worker and separates media processing', () => {
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const worker = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  const mediaWorker = readFileSync('functions/src/scheduled/supplierQueueWorker.ts', 'utf8');
  const index = readFileSync('functions/src/index.ts', 'utf8');
  const rules = readFileSync('firestore.rules', 'utf8');
  const indexes = readFileSync('firestore.indexes.json', 'utf8');

  assert.match(routes, /createSupplierSyncJob\(adminDb/);
  assert.match(routes, /res\.status\(202\)/);
  assert.doesNotMatch(routes, /await runSupplierSync/);
  assert.match(sync, /runScheduledSupplierSync[\s\S]*createSupplierSyncJob/);
  assert.match(worker, /runSupplierSync\(\{/);
  assert.match(worker, /supplierSyncJobCreated/);
  assert.match(worker, /scheduledSupplierSyncJobDispatcher/);
  assert.match(worker, /heartbeatSupplierSyncJob/);
  assert.doesNotMatch(sync, /processSupplierReviewQueueItem|ensureSupplierReviewQueueManagedMedia/);
  assert.match(mediaWorker, /processDueSupplierReviewQueueItems/);
  assert.match(index, /supplierSyncJobCreated/);
  assert.match(rules, /match \/supplier_sync_jobs\/\{docId\}[\s\S]*?allow read, create, update, delete: if false;/);
  assert.match(indexes, /"supplier_sync_jobs"/);
  assert.match(indexes, /"nextAttemptAt"/);
  assert.match(indexes, /"leaseExpiresAt"/);
});
