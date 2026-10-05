import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSupplierSyncPageCommitId,
  classifySupplierSyncIssue,
  commitSupplierSyncPage,
  getSupplierSyncPageCommit,
  reconcileSupplierSyncEvidence,
  SupplierSyncCheckpointConflictError,
} from "../functions/src/api/suppliers/supplierSyncEvidence";
import {
  normalizeSupplierTotalProductLimit,
  normalizeSupplierCatalogPageSize,
} from "../functions/src/scheduled/supplierCatalogTraversal";
import type {
  SupplierSyncAttemptCounters,
  SupplierSyncJobAttemptRecord,
  SupplierSyncJobRecord,
} from "../functions/src/api/suppliers/supplierSyncJobs";

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

  async get(): Promise<FakeSnapshot> { return this.db.snapshot(this.path, this.id); }
}

class FakeCollection {
  constructor(private readonly db: FakeDb, private readonly path: string) {}

  doc(id: string): FakeReference { return new FakeReference(this.db, `${this.path}/${id}`); }
}

class FakeTransaction {
  private readonly writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean; create: boolean }> = [];

  constructor(private readonly db: FakeDb) {}

  async get(reference: FakeReference): Promise<FakeSnapshot> { return this.db.snapshot(reference.path, reference.id); }

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

  write(path: string, value: Record<string, unknown>): void { this.documents.set(path, { ...value }); }

  snapshot(path: string, id: string): FakeSnapshot { return new FakeSnapshot(id, this.read(path)); }

  async runTransaction(callback: (transaction: FakeTransaction) => Promise<unknown>): Promise<unknown> {
    const transaction = new FakeTransaction(this);
    const result = await callback(transaction);
    transaction.apply();
    return result;
  }
}

const dbAsFirestore = (db: FakeDb) => db as unknown as import("firebase-admin/firestore").Firestore;

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

const attempt = (
  attemptId: string,
  attemptNumber: number,
  cursorBefore: string,
  cursorAfter: string,
  values: Partial<SupplierSyncAttemptCounters>,
): SupplierSyncJobAttemptRecord => ({
  evidenceVersion: 2,
  attemptId,
  jobId: "job-1",
  attemptNumber,
  kind: attemptNumber === 1 ? "initial" : "resume",
  status: "completed",
  startedAt: `2026-01-01T00:0${attemptNumber}:00.000Z`,
  completedAt: `2026-01-01T00:0${attemptNumber}:30.000Z`,
  cursorBefore: { dropex: cursorBefore },
  cursorAfter: { dropex: cursorAfter },
  requestedTotalProductLimit: 5000,
  effectiveTotalProductLimit: 5000,
  requestedPageSize: 100,
  effectivePageSize: { dropex: 100 },
  remainingLimitAtStart: { dropex: 5000 },
  counters: counters(values),
  stopReason: "completed",
  errorClass: null,
  errorCode: null,
  errorMessageSafe: null,
  retryable: false,
});

const jobFor = (
  attempts: readonly SupplierSyncJobAttemptRecord[],
  cumulative: SupplierSyncAttemptCounters,
  finalCursor = "C",
): SupplierSyncJobRecord => ({
  id: "job-1",
  schemaVersion: 1,
  evidenceVersion: 2,
  state: "completed",
  jobType: "supplier_sync",
  trigger: "manual",
  sourceIds: ["dropex"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:03:00.000Z",
  nextAttemptAt: null,
  retryCount: 0,
  retryLimit: 5,
  requestedBy: { uid: "admin", email: "admin@example.test" },
  progress: {} as SupplierSyncJobRecord["progress"],
  syncRequest: { mode: "full", totalProductLimit: 5000, pageSize: 100 },
  attemptCount: attempts.length,
  resumeCount: Math.max(0, attempts.length - 1),
  requestedTotalProductLimit: 5000,
  effectiveTotalProductLimit: 5000,
  requestedPageSize: 100,
  effectivePageSize: { dropex: 100 },
  initialCursor: { dropex: "A" },
  durableCursor: { dropex: finalCursor },
  finalCursor: { dropex: finalCursor },
  cumulativeCounters: cumulative,
});

test("Slice 2 reconciles two attempts and preserves the 4645 + 355 cumulative evidence", () => {
  const first = attempt("attempt-1", 1, "A", "B", {
    scanned: 4645, processed: 4645, new: 3000, changeCandidates: 1645, pages: 1,
  });
  const second = attempt("attempt-2", 2, "B", "C", {
    scanned: 355, processed: 355, new: 48, changeCandidates: 306, unchanged: 1, pages: 1,
  });
  const job = jobFor([first, second], counters({
    scanned: 5000, processed: 5000, new: 3048, changeCandidates: 1951, unchanged: 1, pages: 2,
  }));
  const result = reconcileSupplierSyncEvidence(job, [first, second], [
    { pageCommitId: "p1", jobId: "job-1", sourceId: "dropex", attemptId: "attempt-1", attemptNumber: 1, traversalId: "t", status: "committed", cursorBefore: "A", cursorAfter: "B", pageFingerprint: "1", counters: first.counters, checkpointAfter: {}, committedAt: first.completedAt },
    { pageCommitId: "p2", jobId: "job-1", sourceId: "dropex", attemptId: "attempt-2", attemptNumber: 2, traversalId: "t", status: "committed", cursorBefore: "B", cursorAfter: "C", pageFingerprint: "2", counters: second.counters, checkpointAfter: {}, committedAt: second.completedAt },
  ]);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.issues.length, 0);
  assert.equal(result.cumulativeCounters?.scanned, 5000);
  assert.equal(result.cumulativeCounters?.processed, 5000);
});

test("Slice 2 reconciles three attempts without mutating prior attempt evidence", () => {
  const attempts = [
    attempt("attempt-1", 1, "A", "B", { scanned: 100, processed: 100, new: 100, pages: 1 }),
    attempt("attempt-2", 2, "B", "C", { scanned: 100, processed: 100, changeCandidates: 100, pages: 1 }),
    attempt("attempt-3", 3, "C", "D", { scanned: 50, processed: 50, unchanged: 50, pages: 1 }),
  ];
  const originalFirst = JSON.stringify(attempts[0]);
  const result = reconcileSupplierSyncEvidence(jobFor(attempts, counters({
    scanned: 250, processed: 250, new: 100, changeCandidates: 100, unchanged: 50, pages: 3,
  }), "D"), attempts, [
    ...attempts.map((item, index) => ({
      pageCommitId: `p${index + 1}`,
      jobId: "job-1",
      sourceId: "dropex",
      attemptId: item.attemptId,
      attemptNumber: item.attemptNumber,
      traversalId: "t",
      status: "committed" as const,
      cursorBefore: ["A", "B", "C"][index],
      cursorAfter: ["B", "C", "D"][index],
      pageFingerprint: String(index),
      counters: item.counters,
      checkpointAfter: {},
      committedAt: item.completedAt,
    })),
  ]);
  assert.equal(result.status, "VERIFIED");
  assert.equal(JSON.stringify(attempts[0]), originalFirst);
});

test("Slice 2 page commit is idempotent and applies counters once", async () => {
  const db = new FakeDb();
  db.write("supplierSources/dropex", { catalogCursor: "A", catalogSync: { cursor: "A" } });
  db.write("supplier_sync_jobs/job-1", {
    evidenceVersion: 2,
    cumulativeCounters: counters(),
    initialCursor: { dropex: "A" },
    attemptCount: 1,
  });
  db.write("supplier_sync_jobs/job-1/attempts/attempt-1", {
    evidenceVersion: 2,
    status: "running",
    counters: counters(),
    cursorAfter: {},
  });
  const input = {
    db: dbAsFirestore(db),
    jobId: "job-1",
    sourceId: "dropex",
    attemptId: "attempt-1",
    attemptNumber: 1,
    traversalId: "traversal-1",
    pageCommitId: buildSupplierSyncPageCommitId("job-1", "dropex", "traversal-1", "A"),
    cursorBefore: "A",
    cursorAfter: "B",
    pageFingerprint: "fingerprint-1",
    counters: counters({ scanned: 10, processed: 10, new: 10, pages: 1 }),
    checkpointAfter: { cursor: "B", pagesProcessed: 1 },
    sourcePatch: { catalogCursor: "B", catalogSync: { cursor: "B" } },
  };
  const first = await commitSupplierSyncPage(input);
  const replay = await commitSupplierSyncPage(input);
  assert.equal(first.alreadyCommitted, false);
  assert.equal(replay.alreadyCommitted, true);
  assert.equal(db.read("supplierSources/dropex")?.catalogCursor, "B");
  assert.equal((db.read("supplier_sync_jobs/job-1")?.cumulativeCounters as Record<string, unknown>).processed, 10);
  assert.equal((db.read("supplier_sync_jobs/job-1/attempts/attempt-1")?.counters as Record<string, unknown>).processed, 10);
  assert.ok(await getSupplierSyncPageCommit(dbAsFirestore(db), "job-1", input.pageCommitId));
});

test("Slice 2 rejects an unexpected cursor without changing source, page, or counters", async () => {
  const db = new FakeDb();
  db.write("supplierSources/dropex", { catalogCursor: "B", catalogSync: { cursor: "B" } });
  db.write("supplier_sync_jobs/job-1", { evidenceVersion: 2, cumulativeCounters: counters() });
  db.write("supplier_sync_jobs/job-1/attempts/attempt-1", { status: "running", counters: counters() });
  await assert.rejects(() => commitSupplierSyncPage({
    db: dbAsFirestore(db),
    jobId: "job-1",
    sourceId: "dropex",
    attemptId: "attempt-1",
    attemptNumber: 1,
    traversalId: "t",
    pageCommitId: "conflict-page",
    cursorBefore: "A",
    cursorAfter: "C",
    pageFingerprint: "fingerprint",
    counters: counters({ scanned: 10, processed: 10, new: 10, pages: 1 }),
    checkpointAfter: { cursor: "C" },
    sourcePatch: { catalogCursor: "C", catalogSync: { cursor: "C" } },
  }), (error: unknown) => error instanceof SupplierSyncCheckpointConflictError);
  assert.equal(db.read("supplierSources/dropex")?.catalogCursor, "B");
  assert.equal(db.has("supplier_sync_jobs/job-1/pages/conflict-page"), false);
});

test("Slice 2 crash windows keep cursor and contribution semantics bounded", async () => {
  const db = new FakeDb();
  db.write("supplierSources/dropex", { catalogCursor: "A", catalogSync: { cursor: "A" } });
  db.write("supplier_sync_jobs/job-1", { evidenceVersion: 2, cumulativeCounters: counters() });
  db.write("supplier_sync_jobs/job-1/attempts/attempt-1", { status: "running", counters: counters() });
  // A: before outcome commit — no page marker or cursor movement exists.
  assert.equal(db.read("supplierSources/dropex")?.catalogCursor, "A");
  assert.equal(db.has("supplier_sync_jobs/job-1/pages/page-a"), false);
  // B/C: outcome writes are deterministic before the single page commit, and
  // the commit/replay path advances the cursor exactly once.
  const input = {
    db: dbAsFirestore(db), jobId: "job-1", sourceId: "dropex", attemptId: "attempt-1", attemptNumber: 1,
    traversalId: "t", pageCommitId: "page-a", cursorBefore: "A", cursorAfter: "B", pageFingerprint: "f",
    counters: counters({ scanned: 5, processed: 5, new: 5, pages: 1 }), checkpointAfter: { cursor: "B" },
    sourcePatch: { catalogCursor: "B", catalogSync: { cursor: "B" } },
  };
  await commitSupplierSyncPage(input);
  const recovered = await getSupplierSyncPageCommit(dbAsFirestore(db), "job-1", "page-a");
  assert.equal(recovered?.cursorAfter, "B");
  assert.equal((db.read("supplier_sync_jobs/job-1")?.cumulativeCounters as Record<string, unknown>).processed, 5);
  await commitSupplierSyncPage(input);
  assert.equal((db.read("supplier_sync_jobs/job-1")?.cumulativeCounters as Record<string, unknown>).processed, 5);
});

test("Slice 2 preserves bounded limit/page-size semantics", () => {
  for (const limit of [10, 100, 1000, 5000]) assert.equal(normalizeSupplierTotalProductLimit(limit), limit);
  assert.equal(normalizeSupplierTotalProductLimit(50_000), 10_000);
  assert.equal(normalizeSupplierCatalogPageSize(100), 100);
  assert.equal(normalizeSupplierCatalogPageSize(500), 200);
});

test("Slice 2 classifies retryable, permanent, validation, and normalization failures", () => {
  assert.equal(classifySupplierSyncIssue(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })), "MEDIA_RETRYABLE");
  assert.equal(classifySupplierSyncIssue(Object.assign(new Error("too large"), { code: "IMAGE_TOO_LARGE" })), "MEDIA_PERMANENT");
  assert.equal(classifySupplierSyncIssue(new Error("invalid URL")), "VALIDATION_REJECTION");
  assert.equal(classifySupplierSyncIssue(new Error("normalization failed")), "NORMALIZATION_ERROR");
  assert.equal(classifySupplierSyncIssue(Object.assign(new Error("cursor conflict"), { code: "CHECKPOINT_ERROR" })), "CHECKPOINT_ERROR");
});

test("Slice 2 never verifies legacy jobs by inference", () => {
  const legacy = { ...jobFor([], counters()), evidenceVersion: 1, cumulativeCounters: null };
  const result = reconcileSupplierSyncEvidence(legacy, [], []);
  assert.equal(result.status, "LEGACY_UNVERIFIED");
});
