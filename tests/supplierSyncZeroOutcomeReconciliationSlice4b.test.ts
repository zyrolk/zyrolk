import assert from "node:assert/strict";
import test from "node:test";
import {
  beginSupplierSyncAttempt,
  finalizeSupplierSyncAttempt,
  type SupplierSyncAttemptCounters,
  type SupplierSyncJobAttemptRecord,
  type SupplierSyncJobRecord,
} from "../functions/src/api/suppliers/supplierSyncJobs";
import {
  buildSupplierSyncPageCommitId,
  commitSupplierSyncPage,
  getSupplierSyncPageCommit,
  reconcileSupplierSyncEvidence,
} from "../functions/src/api/suppliers/supplierSyncEvidence";

class FakeSnapshot {
  constructor(
    readonly id: string,
    private readonly value: Record<string, unknown> | undefined,
  ) {}

  get exists(): boolean { return Boolean(this.value); }
  data(): Record<string, unknown> | undefined { return this.value ? { ...this.value } : undefined; }
}

class FakeReference {
  constructor(private readonly db: FakeDb, readonly path: string) {}

  get id(): string { return this.path.split("/").at(-1) || ""; }
  collection(name: string): FakeCollection { return new FakeCollection(this.db, `${this.path}/${name}`); }
}

class FakeCollection {
  constructor(private readonly db: FakeDb, private readonly path: string) {}

  doc(id: string): FakeReference { return new FakeReference(this.db, `${this.path}/${id}`); }
}

class FakeTransaction {
  private readonly writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean; create: boolean }> = [];

  constructor(private readonly db: FakeDb) {}

  async get(reference: FakeReference): Promise<FakeSnapshot> {
    return this.db.snapshot(reference.path, reference.id);
  }

  set(reference: FakeReference, data: Record<string, unknown>, options?: { merge?: boolean }): void {
    this.writes.push({ path: reference.path, data, merge: options?.merge === true, create: false });
  }

  create(reference: FakeReference, data: Record<string, unknown>): void {
    this.writes.push({ path: reference.path, data, merge: false, create: true });
  }

  apply(): void {
    for (const write of this.writes) {
      if (write.create && this.db.has(write.path)) throw new Error("already exists");
      const previous = this.db.read(write.path) || {};
      this.db.write(write.path, write.merge ? { ...previous, ...write.data } : { ...write.data });
    }
  }
}

class FakeDb {
  private readonly documents = new Map<string, Record<string, unknown>>();

  collection(name: string): FakeCollection { return new FakeCollection(this, name); }
  has(path: string): boolean { return this.documents.has(path); }

  read(path: string): Record<string, unknown> | undefined {
    const value = this.documents.get(path);
    return value ? { ...value } : undefined;
  }

  write(path: string, value: Record<string, unknown>): void {
    this.documents.set(path, { ...value });
  }

  snapshot(path: string, id: string): FakeSnapshot {
    return new FakeSnapshot(id, this.read(path));
  }

  async runTransaction(callback: (transaction: FakeTransaction) => Promise<unknown>): Promise<unknown> {
    const transaction = new FakeTransaction(this);
    const result = await callback(transaction);
    transaction.apply();
    return result;
  }
}

const asFirestore = (db: FakeDb) => db as unknown as import("firebase-admin/firestore").Firestore;

const counters = (overrides: Partial<SupplierSyncAttemptCounters> = {}): SupplierSyncAttemptCounters => ({
  scanned: 0,
  processed: 0,
  queued: 0,
  new: 0,
  changeCandidates: 0,
  unchanged: 0,
  rejected: 0,
  failed: 0,
  warnings: 0,
  pages: 0,
  ...overrides,
});

const baseJob = (cumulativeCounters: SupplierSyncAttemptCounters = counters()): Record<string, unknown> => ({
  evidenceVersion: 2,
  state: "running",
  leaseOwner: "worker-1",
  leaseId: "lease-1",
  attemptCount: 1,
  resumeCount: 0,
  requestedTotalProductLimit: 5,
  effectiveTotalProductLimit: 5,
  cumulativeCounters,
  syncRequest: { totalProductLimit: 5, pageSize: 100 },
});

const prepareRunningAttempt = async (db: FakeDb): Promise<SupplierSyncJobAttemptRecord> => {
  db.write("supplier_sync_jobs/job-1", baseJob());
  return beginSupplierSyncAttempt(asFirestore(db), "job-1", "worker-1", "lease-1", {
    attemptId: "attempt-1",
    kind: "initial",
    startedAt: "2026-10-05T04:00:00.000Z",
  }, Date.parse("2026-10-05T04:00:00.000Z"));
};

const commitFiveProductPage = async (db: FakeDb): Promise<void> => {
  const input = {
    db: asFirestore(db),
    jobId: "job-1",
    sourceId: "dropex",
    attemptId: "attempt-1",
    attemptNumber: 1,
    traversalId: "traversal-1",
    pageCommitId: buildSupplierSyncPageCommitId("job-1", "dropex", "traversal-1", "A"),
    cursorBefore: "A",
    cursorAfter: "B",
    pageFingerprint: "fingerprint-1",
    counters: counters({ scanned: 5, processed: 5, queued: 5, new: 5, pages: 1 }),
    checkpointAfter: { cursor: "B" },
    sourcePatch: { catalogCursor: "B", catalogSync: { cursor: "B" } },
  };
  db.write("supplierSources/dropex", { catalogCursor: "A", catalogSync: { cursor: "A" } });
  await commitSupplierSyncPage(input);
  await finalizeSupplierSyncAttempt(asFirestore(db), "job-1", "worker-1", "lease-1", "attempt-1", {
    status: "completed",
    cursorAfter: { dropex: "B" },
    countersAlreadyApplied: true,
    stopReason: "limit_reached",
  }, Date.parse("2026-10-05T04:00:03.000Z"));
};

const readEvidence = (db: FakeDb): {
  job: SupplierSyncJobRecord;
  attempt: SupplierSyncJobAttemptRecord;
  page: NonNullable<Awaited<ReturnType<typeof getSupplierSyncPageCommit>>>;
} => {
  const job = { id: "job-1", ...db.read("supplier_sync_jobs/job-1") } as SupplierSyncJobRecord;
  const attempt = { attemptId: "attempt-1", jobId: "job-1", ...db.read("supplier_sync_jobs/job-1/attempts/attempt-1") } as SupplierSyncJobAttemptRecord;
  const page = { id: "page", ...db.read(`supplier_sync_jobs/job-1/pages/${buildSupplierSyncPageCommitId("job-1", "dropex", "traversal-1", "A")}`) } as unknown as NonNullable<Awaited<ReturnType<typeof getSupplierSyncPageCommit>>>;
  return { job, attempt, page };
};

test("Slice 4B exact canary case records known zero outcomes and verifies cleanly", async () => {
  const db = new FakeDb();
  const created = await prepareRunningAttempt(db);
  assert.equal(created.counters.new, 0);
  assert.equal(created.counters.changeCandidates, 0);
  assert.equal(created.counters.unchanged, 0);
  assert.equal(created.counters.rejected, 0);
  assert.equal(created.counters.failed, 0);

  await commitFiveProductPage(db);
  const { job, attempt, page } = readEvidence(db);
  assert.deepEqual(attempt.counters, counters({ scanned: 5, processed: 5, queued: 5, new: 5, pages: 1 }));
  assert.deepEqual(job.cumulativeCounters, counters({ scanned: 5, processed: 5, queued: 5, new: 5, pages: 1 }));
  assert.equal(page.counters.rejected, 0);
  assert.equal(reconcileSupplierSyncEvidence(job, [attempt], [page]).status, "VERIFIED");
});

test("Slice 4B preserves every known zero through numeric merge", () => {
  const fields: Array<keyof SupplierSyncAttemptCounters> = ["new", "changeCandidates", "unchanged", "rejected", "failed"];
  for (const field of fields) {
    const values: Partial<SupplierSyncAttemptCounters> = {
      processed: 1,
      pages: 1,
      ...(field === "unchanged" ? { new: 1 } : { unchanged: 1 }),
    };
    values[field] = 0;
    const attempt: SupplierSyncJobAttemptRecord = {
      evidenceVersion: 2,
      attemptId: `attempt-${field}`,
      jobId: "job-1",
      attemptNumber: 1,
      kind: "initial",
      status: "completed",
      startedAt: "2026-10-05T04:00:00.000Z",
      completedAt: "2026-10-05T04:00:03.000Z",
      cursorBefore: { dropex: "A" },
      cursorAfter: { dropex: "B" },
      requestedTotalProductLimit: 1,
      effectiveTotalProductLimit: 1,
      requestedPageSize: 100,
      effectivePageSize: { dropex: 100 },
      remainingLimitAtStart: { dropex: 1 },
      counters: counters(values),
      stopReason: "completed",
      errorClass: null,
      errorCode: null,
      errorMessageSafe: null,
      retryable: false,
    };
    const page = {
      pageCommitId: `page-${field}`,
      jobId: "job-1",
      sourceId: "dropex",
      attemptId: attempt.attemptId,
      attemptNumber: 1,
      traversalId: "t",
      status: "committed" as const,
      cursorBefore: "A",
      cursorAfter: "B",
      pageFingerprint: field,
      counters: attempt.counters,
      checkpointAfter: {},
      committedAt: attempt.completedAt as string,
    };
    const job: SupplierSyncJobRecord = {
      id: "job-1",
      schemaVersion: 1,
      evidenceVersion: 2,
      state: "completed",
      jobType: "supplier_sync",
      trigger: "manual",
      sourceIds: ["dropex"],
      createdAt: attempt.startedAt,
      updatedAt: attempt.completedAt as string,
      nextAttemptAt: null,
      retryCount: 0,
      retryLimit: 5,
      requestedBy: { uid: "admin", email: "admin@example.test" },
      progress: {} as SupplierSyncJobRecord["progress"],
      syncRequest: { mode: "full", totalProductLimit: 1, pageSize: 100 },
      attemptCount: 1,
      resumeCount: 0,
      requestedTotalProductLimit: 1,
      effectiveTotalProductLimit: 1,
      requestedPageSize: 100,
      effectivePageSize: { dropex: 100 },
      initialCursor: { dropex: "A" },
      durableCursor: { dropex: "B" },
      finalCursor: { dropex: "B" },
      cumulativeCounters: counters(values),
    };
    assert.equal(reconcileSupplierSyncEvidence(job, [attempt], [page]).status, "VERIFIED", field);
    assert.equal(attempt.counters[field], 0, field);
  }
});

test("Slice 4B keeps explicit legacy null evidence unknown", () => {
  const legacy = { evidenceVersion: 1, cumulativeCounters: null } as SupplierSyncJobRecord;
  const result = reconcileSupplierSyncEvidence(legacy, [], []);
  assert.equal(result.status, "LEGACY_UNVERIFIED");
});

test("Slice 4B reconciles two attempts with numeric zero contributions", () => {
  const makeAttempt = (id: string, number: number, before: string, after: string, count: number): SupplierSyncJobAttemptRecord => ({
    evidenceVersion: 2,
    attemptId: id,
    jobId: "job-1",
    attemptNumber: number,
    kind: number === 1 ? "initial" : "resume",
    status: "completed",
    startedAt: `2026-10-05T04:0${number}:00.000Z`,
    completedAt: `2026-10-05T04:0${number}:03.000Z`,
    cursorBefore: { dropex: before },
    cursorAfter: { dropex: after },
    requestedTotalProductLimit: 5,
    effectiveTotalProductLimit: 5,
    requestedPageSize: 100,
    effectivePageSize: { dropex: 100 },
    remainingLimitAtStart: { dropex: count },
    counters: counters({ scanned: count, processed: count, new: count, pages: 1 }),
    stopReason: "completed",
    errorClass: null,
    errorCode: null,
    errorMessageSafe: null,
    retryable: false,
  });
  const first = makeAttempt("attempt-1", 1, "A", "B", 3);
  const second = makeAttempt("attempt-2", 2, "B", "C", 2);
  const total = counters({ scanned: 5, processed: 5, new: 5, pages: 2 });
  const job = {
    ...({} as SupplierSyncJobRecord),
    evidenceVersion: 2,
    attemptCount: 2,
    effectiveTotalProductLimit: 5,
    cumulativeCounters: total,
  } as SupplierSyncJobRecord;
  const pages = [first, second].map((item, index) => ({
    pageCommitId: `page-${index + 1}`,
    jobId: "job-1",
    sourceId: "dropex",
    attemptId: item.attemptId,
    attemptNumber: item.attemptNumber,
    traversalId: "t",
    status: "committed" as const,
    cursorBefore: index === 0 ? "A" : "B",
    cursorAfter: index === 0 ? "B" : "C",
    pageFingerprint: String(index),
    counters: item.counters,
    checkpointAfter: {},
    committedAt: item.completedAt as string,
  }));
  assert.equal(reconcileSupplierSyncEvidence(job, [first, second], pages).status, "VERIFIED");
});

test("Slice 4B preserves a real rejected count", () => {
  const rejected: SupplierSyncJobAttemptRecord = {
    evidenceVersion: 2,
    attemptId: "attempt-rejected",
    jobId: "job-1",
    attemptNumber: 1,
    kind: "initial",
    status: "completed",
    startedAt: "2026-10-05T04:00:00.000Z",
    completedAt: "2026-10-05T04:00:03.000Z",
    cursorBefore: { dropex: "A" },
    cursorAfter: { dropex: "B" },
    requestedTotalProductLimit: 5,
    effectiveTotalProductLimit: 5,
    requestedPageSize: 100,
    effectivePageSize: { dropex: 100 },
    remainingLimitAtStart: { dropex: 5 },
    counters: counters({ scanned: 5, processed: 5, new: 4, rejected: 1, pages: 1 }),
    stopReason: "completed",
    errorClass: null,
    errorCode: null,
    errorMessageSafe: null,
    retryable: false,
  };
  const page = {
    pageCommitId: "page-rejected",
    jobId: "job-1",
    sourceId: "dropex",
    attemptId: rejected.attemptId,
    attemptNumber: 1,
    traversalId: "t",
    status: "committed" as const,
    cursorBefore: "A",
    cursorAfter: "B",
    pageFingerprint: "rejected",
    counters: rejected.counters,
    checkpointAfter: {},
    committedAt: rejected.completedAt as string,
  };
  const job = {
    ...({} as SupplierSyncJobRecord),
    evidenceVersion: 2,
    attemptCount: 1,
    effectiveTotalProductLimit: 5,
    cumulativeCounters: rejected.counters,
  } as SupplierSyncJobRecord;
  const result = reconcileSupplierSyncEvidence(job, [rejected], [page]);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.cumulativeCounters?.rejected, 1);
});
