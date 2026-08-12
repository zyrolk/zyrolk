import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import {
  calculateSupplierSyncJobProgress,
  completeSupplierSyncJob,
  createSupplierSyncJob,
  leaseSupplierSyncJob,
  projectSupplierSyncJobForAdmin,
  requestSupplierSyncJobCancellation,
  requeueSupplierSyncJob,
  SupplierSyncJobConflictError,
} from '../functions/src/api/suppliers/supplierSyncJobs';

interface FakeReference { id: string; path: string }

const applyPatch = (
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...current };
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === 'object' && value.constructor.name === 'DeleteTransform') delete next[key];
    else next[key] = value;
  });
  return next;
};

/**
 * This fake verifies deterministic state behavior only. It deliberately does
 * not claim to reproduce Firestore transaction contention/retry semantics.
 */
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
    get(reference: FakeReference): Promise<{
      id: string;
      exists: boolean;
      data(): Record<string, unknown> | undefined;
    }>;
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
        if (this.documents.has(reference.path)) throw new Error(`Document already exists: ${reference.path}`);
        this.documents.set(reference.path, { ...data });
      }),
      set: (reference: FakeReference, data: Record<string, unknown>, options?: { merge?: boolean }) => writes.push(() => {
        this.documents.set(reference.path, options?.merge
          ? applyPatch(this.documents.get(reference.path) || {}, data)
          : applyPatch({}, data));
      }),
    };
    const result = await callback(transaction);
    writes.forEach((write) => write());
    return result;
  }
}

const manualInput = (sourceIds: string[] = ['a2z-traders']) => ({
  trigger: 'manual' as const,
  sourceIds,
  requestedBy: { uid: 'admin-1', email: 'admin@zyro.lk' },
  syncRequest: {
    mode: 'full' as const,
    filters: { category: 'Phones', search: 'Samsung' },
    pageSize: 25,
    totalProductLimit: 100,
  },
});

test('SH-2B persists and projects the explicit full sync request', async () => {
  const db = new FakeFirestore();
  const created = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 1_000);

  assert.equal(created.created, true);
  assert.equal(created.deduplicated, false);
  assert.deepEqual(created.job.syncRequest, manualInput().syncRequest);
  assert.deepEqual(db.documents.get(`supplier_sync_jobs/${created.job.id}`)?.syncRequest, manualInput().syncRequest);
  assert.deepEqual(projectSupplierSyncJobForAdmin(created.job).syncRequest, manualInput().syncRequest);
});

test('SH-2B reuses one active job for repeated requests with the exact same source scope', async () => {
  const db = new FakeFirestore();
  const first = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 1_000);
  const repeated = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 1_001);

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.job.id, first.job.id);
  assert.equal([...db.documents.keys()].filter((path) => path.startsWith('supplier_sync_jobs/')).length, 1);
});

test('SH-2B rejects the same source when active and requested sync controls differ', async () => {
  for (const syncRequest of [
    { ...manualInput().syncRequest, filters: { category: 'Laptops', search: 'Samsung' } },
    { mode: 'incremental' as const },
  ]) {
    const db = new FakeFirestore();
    const first = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 5_000);

    await assert.rejects(
      createSupplierSyncJob(db as unknown as Firestore, {
        ...manualInput(),
        syncRequest,
      }, 5_001),
      (error: unknown) => {
        assert.ok(error instanceof SupplierSyncJobConflictError);
        assert.equal(error.statusCode, 409);
        assert.deepEqual(error.conflicts, [{
          sourceId: 'a2z-traders',
          jobId: first.job.id,
          state: 'pending',
        }]);
        return true;
      },
    );
    assert.equal([...db.documents.keys()].filter((path) => path.startsWith('supplier_sync_jobs/')).length, 1);
  }
});

test('SH-2B terminal completion permits a later manual job for the same source', async () => {
  const db = new FakeFirestore();
  const now = 10_000;
  const first = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), now);
  const lease = await leaseSupplierSyncJob(db as unknown as Firestore, first.job.id, 'worker-1', now);
  assert.ok(lease);
  const progress = calculateSupplierSyncJobProgress(now, {
    phase: 'completed', totalSources: 1, completedSources: 1,
  }, now + 1_000);
  assert.equal(await completeSupplierSyncJob(
    db as unknown as Firestore,
    first.job.id,
    'worker-1',
    lease.leaseId,
    { status: 'Success' },
    progress,
    now + 1_000,
  ), true);

  const later = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), now + 2_000);
  assert.equal(later.created, true);
  assert.notEqual(later.job.id, first.job.id);
});

test('SH-2B safely reclaims a reservation whose owner job is missing', async () => {
  const db = new FakeFirestore();
  db.seed('supplier_sync_locks/source-a2z-traders', {
    sourceId: 'a2z-traders',
    manualReservationJobId: 'missing-job',
  });

  const created = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 20_000);
  assert.equal(created.created, true);
  assert.equal(
    db.documents.get('supplier_sync_locks/source-a2z-traders')?.manualReservationJobId,
    created.job.id,
  );
});

test('SH-2B recognizes an active pre-reservation source execution lock', async () => {
  const db = new FakeFirestore();
  db.seed('supplier_sync_jobs/legacy-running-job', {
    ...manualInput(),
    id: 'legacy-running-job',
    state: 'running',
    sourceIds: ['a2z-traders'],
  });
  db.seed('supplier_sync_locks/source-a2z-traders', {
    sourceId: 'a2z-traders',
    status: 'running',
    owner: 'legacy-running-job',
    lockedUntil: new Date(90_000).toISOString(),
  });

  const repeated = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 60_000);
  assert.equal(repeated.created, false);
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.job.id, 'legacy-running-job');
  assert.equal([...db.documents.keys()].filter((path) => path.startsWith('supplier_sync_jobs/')).length, 1);
});

test('SH-2B rejects overlapping non-identical scopes atomically with sorted conflict details', async () => {
  const db = new FakeFirestore();
  const first = await createSupplierSyncJob(db as unknown as Firestore, manualInput(['supplier-a']), 30_000);

  await assert.rejects(
    createSupplierSyncJob(db as unknown as Firestore, manualInput(['supplier-b', 'supplier-a']), 30_001),
    (error: unknown) => {
      assert.ok(error instanceof SupplierSyncJobConflictError);
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.conflicts, [{ sourceId: 'supplier-a', jobId: first.job.id, state: 'pending' }]);
      assert.deepEqual(error.details, {
        code: 'supplier_sync_job_conflict',
        conflicts: [{ sourceId: 'supplier-a', jobId: first.job.id, state: 'pending' }],
      });
      return true;
    },
  );

  assert.equal([...db.documents.keys()].filter((path) => path.startsWith('supplier_sync_jobs/')).length, 1);
  assert.equal(db.documents.has('supplier_sync_locks/source-supplier-b'), false);
});

test('SH-2B keeps scheduled minute-key idempotency unchanged', async () => {
  const db = new FakeFirestore();
  const input = {
    trigger: 'scheduled' as const,
    dedupeKey: 'scheduled-2026080110',
    requestedBy: { uid: 'system', email: '' },
  };
  const first = await createSupplierSyncJob(db as unknown as Firestore, input, 40_000);
  const repeated = await createSupplierSyncJob(db as unknown as Firestore, input, 40_001);

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.job.id, first.job.id);
  assert.equal(db.documents.has('supplier_sync_locks/source-a2z-traders'), false);
});

test('SH-2B retry/resume cannot steal another active job reservation', async () => {
  const db = new FakeFirestore();
  const first = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 50_000);
  const cancelledFirst = await requestSupplierSyncJobCancellation(
    db as unknown as Firestore, first.job.id, 'admin-1', 50_001,
  );
  assert.equal(cancelledFirst?.state, 'cancelled');

  const second = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), 50_002);
  const blockedResume = await requeueSupplierSyncJob(
    db as unknown as Firestore, first.job.id, 'resume', 'admin-1', 50_003,
  );
  assert.equal(blockedResume?.state, 'cancelled');
  assert.equal(
    db.documents.get('supplier_sync_locks/source-a2z-traders')?.manualReservationJobId,
    second.job.id,
  );

  await requestSupplierSyncJobCancellation(db as unknown as Firestore, second.job.id, 'admin-1', 50_004);
  const resumed = await requeueSupplierSyncJob(
    db as unknown as Firestore, first.job.id, 'resume', 'admin-1', 50_005,
  );
  assert.equal(resumed?.state, 'pending');
  assert.equal(
    db.documents.get('supplier_sync_locks/source-a2z-traders')?.manualReservationJobId,
    first.job.id,
  );
});

test('SH-2B retry/resume refuses a valid execution lock owned by another job', async () => {
  const db = new FakeFirestore();
  const now = 60_000;
  const first = await createSupplierSyncJob(db as unknown as Firestore, manualInput(), now);
  await requestSupplierSyncJobCancellation(db as unknown as Firestore, first.job.id, 'admin-1', now + 1);
  db.seed('supplier_sync_locks/source-a2z-traders', {
    sourceId: 'a2z-traders',
    status: 'running',
    owner: 'other-job',
    lockedUntil: new Date(now + 60_000).toISOString(),
  });

  const blocked = await requeueSupplierSyncJob(
    db as unknown as Firestore, first.job.id, 'resume', 'admin-1', now + 2,
  );
  assert.equal(blocked?.state, 'cancelled');
  assert.equal(
    db.documents.get('supplier_sync_locks/source-a2z-traders')?.manualReservationJobId,
    undefined,
  );

  db.seed('supplier_sync_locks/source-a2z-traders', {
    sourceId: 'a2z-traders',
    status: 'running',
    owner: first.job.id,
    lockedUntil: new Date(now + 60_000).toISOString(),
  });
  const resumed = await requeueSupplierSyncJob(
    db as unknown as Firestore, first.job.id, 'resume', 'admin-1', now + 3,
  );
  assert.equal(resumed?.state, 'pending');
  assert.equal(
    db.documents.get('supplier_sync_locks/source-a2z-traders')?.manualReservationJobId,
    first.job.id,
  );
});
