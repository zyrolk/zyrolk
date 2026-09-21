import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { adminAuth } from "../functions/src/api/firebase";
import {
  admitPendingReviewBatch,
  parsePendingReviewBatchSize,
  processPendingReviewRefreshJob,
  PendingReviewBatchState,
} from "../functions/src/api/suppliers/supplierReviewBatchRefresh";
import { clearPendingReviewBatchPollTimer, pendingReviewBatchPollDelayMs } from "../src/services/supplierSyncJobs";

const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsEmulatorHost = process.env.FUNCTIONS_EMULATOR_HOST;
const emulatorProjectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRunPendingReviewBatchApi = Boolean(
  firestoreEmulatorHost && authEmulatorHost && functionsEmulatorHost && emulatorProjectId?.startsWith("demo-"),
);

type ReviewRecord = Record<string, unknown>;
const makeRecord = (id: string, updatedAt: string, overrides: ReviewRecord = {}): ReviewRecord => ({
  queueState: "review_pending",
  status: "Pending",
  createdAt: updatedAt,
  updatedAt,
  sourceId: "dropex",
  supplierId: "dropex",
  supplierSku: id.toUpperCase(),
  productValidation: { readyToPublish: false },
  ...overrides,
});

const createSelectionDb = (records: Map<string, ReviewRecord>) => ({
  collection: () => ({
    where: () => ({
      get: async () => ({ docs: [...records.entries()].map(([id, data]) => ({ id, data: () => data })) }),
    }),
  }),
} as never);

const jobFor = (state: PendingReviewBatchState, overrides: ReviewRecord = {}) => ({
  id: "pending-refresh-job",
  state: "running",
  jobType: "pending_review_refresh",
  trigger: "manual",
  sourceIds: state.sourceIds,
  requestedBy: { uid: "admin-1", email: "admin@example.com" },
  createdAt: "2026-09-21T00:00:00.000Z",
  startedAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  nextAttemptAt: "2026-09-21T00:00:00.000Z",
  retryCount: 0,
  retryLimit: 5,
  resumeCount: 0,
  progress: {},
  pendingReviewBatch: state,
  ...overrides,
} as never);

test("pending batch admission is bounded, deterministic, durable, and does not refresh inline", async () => {
  const records = new Map<string, ReviewRecord>(Array.from({ length: 125 }, (_, index) => {
    const id = `review-${String(index).padStart(3, "0")}`;
    return [id, makeRecord(id, new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 60_000).toISOString())] as const;
  }));
  let createCalls = 0;
  let createdInput: Record<string, unknown> | null = null;
  const result = await admitPendingReviewBatch(
    { limit: 100 },
    { uid: "admin-1", email: "admin@example.com" },
    {
      db: createSelectionDb(records),
      now: 1_000,
      createJob: async (_db, input) => {
        createCalls += 1;
        createdInput = input as unknown as Record<string, unknown>;
        return {
          created: true,
          deduplicated: false,
          job: jobFor(input.pendingReviewBatch as unknown as PendingReviewBatchState),
        };
      },
    },
  );
  assert.equal(createCalls, 1);
  assert.equal(result.created, true);
  assert.equal(createdInput?.jobType, "pending_review_refresh");
  const batch = createdInput?.pendingReviewBatch as unknown as PendingReviewBatchState;
  assert.equal(batch.selectedQueueItemIds.length, 100);
  assert.deepEqual(batch.selectedQueueItemIds.slice(0, 3), ["review-000", "review-001", "review-002"]);
  assert.equal(batch.nextItemIndex, 0);
  assert.deepEqual(batch.outcomes, []);
});

test("legacy pending records without queueState use the same refreshable eligibility rule", async () => {
  const legacy = makeRecord("legacy-pending", "2026-09-01T00:00:00.000Z");
  delete legacy.queueState;
  const terminal = makeRecord("legacy-approved", "2026-09-01T00:01:00.000Z", { status: "Approved" });
  const selected = await (await import("../functions/src/api/suppliers/supplierReviewBatchRefresh")).selectPendingReviewQueueItems(
    createSelectionDb(new Map([["legacy-pending", legacy], ["legacy-approved", terminal]])),
    25,
  );
  assert.deepEqual(selected.map((item) => item.id), ["legacy-pending"]);
});

test("only supported batch sizes are admitted and duplicate admission can reuse the durable job", () => {
  assert.equal(parsePendingReviewBatchSize({ limit: 25 }), 25);
  assert.equal(parsePendingReviewBatchSize({ limit: 50 }), 50);
  assert.equal(parsePendingReviewBatchSize({ limit: 100 }), 100);
  for (const invalid of [undefined, {}, { limit: "25" }, { limit: 0 }, { limit: 101 }, { limit: 25, extra: true }, { limit: [25] }]) {
    assert.throws(() => parsePendingReviewBatchSize(invalid), /25, 50, or 100|required/u);
  }
});

test("worker processes immutable selected IDs sequentially, isolates failures, and records truthful outcomes", async () => {
  const selected = ["ok", "removed", "failed", "ready", "unchanged"];
  const state: PendingReviewBatchState = {
    batchSize: 25,
    selectedQueueItemIds: selected,
    sourceIds: ["dropex"],
    nextItemIndex: 0,
    inFlightQueueItemId: null,
    inFlightStartedAt: null,
    outcomes: [],
  };
  const calls: string[] = [];
  let lastState: PendingReviewBatchState = state;
  const result = await processPendingReviewRefreshJob(jobFor(state), {
    workerId: "worker-1",
    leaseId: "lease-1",
    revalidateItem: async () => true,
    refreshItem: async (id) => {
      calls.push(id);
      if (id === "removed") throw new Error("The exact Dropex reseller catalogue row could not be found within the refresh bounds.");
      if (id === "failed") throw new Error("Dropex refresh catalogue lookup exceeded its time bound.");
      return { queueItemId: id, item: { comparisonStatus: id === "ok" || id === "ready" ? "PRICE_CHANGED" : "UNCHANGED", productValidation: { readyToPublish: id === "ready" } } } as never;
    },
    updateProgress: async (_db, _jobId, _workerId, _leaseId, persisted) => {
      lastState = persisted as unknown as PendingReviewBatchState;
    },
    now: (() => { let value = 1_000; return () => (value += 1); })(),
    maxActiveMs: 1_000_000,
  });
  assert.deepEqual(calls, selected);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.selectedQueueItemIds, selected);
  assert.equal(result.state.nextItemIndex, 5);
  assert.equal(result.state.outcomes.filter((item) => item.outcome === "supplier_not_found").length, 1);
  assert.equal(result.state.outcomes.filter((item) => item.outcome === "failed").length, 1);
  assert.equal(result.state.outcomes.filter((item) => item.outcome === "ready_to_publish").length, 1);
  assert.equal(result.state.outcomes.filter((item) => item.outcome === "unchanged").length, 1);
  assert.equal(lastState.inFlightQueueItemId, null);
});

test("worker resumes from the durable next index and does not reprocess terminal outcomes", async () => {
  const state: PendingReviewBatchState = {
    batchSize: 25,
    selectedQueueItemIds: ["first", "second", "third"],
    sourceIds: ["dropex"],
    nextItemIndex: 0,
    inFlightQueueItemId: null,
    inFlightStartedAt: null,
    outcomes: [],
  };
  const calls: string[] = [];
  let persisted: PendingReviewBatchState = state;
  const firstRun = await processPendingReviewRefreshJob(jobFor(state, { createdAt: "1970-01-01T00:00:00.000Z", startedAt: "1970-01-01T00:00:00.000Z" }), {
    workerId: "worker-1",
    leaseId: "lease-1",
    revalidateItem: async () => true,
    refreshItem: async (id) => { calls.push(id); return { queueItemId: id, item: { productValidation: { readyToPublish: false } } } as never; },
    updateProgress: async (_db, _jobId, _workerId, _leaseId, next) => { persisted = next as unknown as PendingReviewBatchState; },
    now: (() => { let value = 1_000; return () => (value += 1); })(),
    maxActiveMs: 0,
  });
  assert.equal(firstRun.status, "waiting");
  assert.deepEqual(calls, ["first"]);
  const resumed = await processPendingReviewRefreshJob(jobFor(persisted), {
    workerId: "worker-2",
    leaseId: "lease-2",
    revalidateItem: async () => true,
    refreshItem: async (id) => { calls.push(id); return { queueItemId: id, item: { productValidation: { readyToPublish: false } } } as never; },
    updateProgress: async (_db, _jobId, _workerId, _leaseId, next) => { persisted = next as unknown as PendingReviewBatchState; },
    now: (() => { let value = 2_000; return () => (value += 1); })(),
    maxActiveMs: 1_000_000,
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("worker revalidates terminal and conflict state before supplier refresh", async () => {
  for (const changedState of ["approved", "conflict"]) {
    const state: PendingReviewBatchState = {
      batchSize: 25,
      selectedQueueItemIds: [`changed-${changedState}`],
      sourceIds: ["dropex"],
      nextItemIndex: 0,
      inFlightQueueItemId: null,
      inFlightStartedAt: null,
      outcomes: [],
    };
    let refreshCalls = 0;
    let persisted: PendingReviewBatchState = state;
    const result = await processPendingReviewRefreshJob(jobFor(state), {
      workerId: "worker-race",
      leaseId: "lease-race",
      revalidateItem: async () => changedState === "review_pending",
      refreshItem: async () => { refreshCalls += 1; throw new Error("must not refresh a changed item"); },
      updateProgress: async (_db, _jobId, _workerId, _leaseId, next) => { persisted = next as unknown as PendingReviewBatchState; },
      now: (() => { let value = 1_000; return () => (value += 1); })(),
    });
    assert.equal(refreshCalls, 0);
    assert.equal(result.state.nextItemIndex, 1);
    assert.equal(result.state.outcomes[0]?.outcome, "failed");
    assert.match(result.state.outcomes[0]?.error || "", /changed before/u);
    assert.equal(persisted.inFlightQueueItemId, null);
  }
});

test("crash after refresh write is recovered once without duplicate refresh or metrics", async () => {
  const state: PendingReviewBatchState = {
    batchSize: 25,
    selectedQueueItemIds: ["crash-once"],
    sourceIds: ["dropex"],
    nextItemIndex: 0,
    inFlightQueueItemId: null,
    inFlightStartedAt: null,
    outcomes: [],
  };
  let refreshCalls = 0;
  let persistedBeforeCrash: PendingReviewBatchState | null = null;
  let persistCalls = 0;
  await assert.rejects(processPendingReviewRefreshJob(jobFor(state), {
    workerId: "worker-crash",
    leaseId: "lease-crash",
    revalidateItem: async () => true,
    refreshItem: async () => {
      refreshCalls += 1;
      return { queueItemId: "crash-once", item: { comparisonStatus: "PRICE_CHANGED", productValidation: { readyToPublish: false } } } as never;
    },
    updateProgress: async (_db, _jobId, _workerId, _leaseId, next) => {
      persistCalls += 1;
      if (persistCalls === 1) persistedBeforeCrash = JSON.parse(JSON.stringify(next)) as PendingReviewBatchState;
      else throw new Error("simulated crash after refresh write");
    },
    now: (() => { let value = 1_000; return () => (value += 1); })(),
  }), /simulated crash/u);
  assert.equal(refreshCalls, 1);
  assert.ok(persistedBeforeCrash?.inFlightQueueItemId === "crash-once");

  const recovered = await processPendingReviewRefreshJob(jobFor(persistedBeforeCrash!), {
    workerId: "worker-recovery",
    leaseId: "lease-recovery",
    revalidateItem: async () => { throw new Error("recovery must not revalidate a completed in-flight item"); },
    refreshItem: async () => { refreshCalls += 1; throw new Error("must not refresh twice"); },
    updateProgress: async () => undefined,
    now: (() => { let value = 2_000; return () => (value += 1); })(),
  });
  assert.equal(refreshCalls, 1);
  assert.equal(recovered.state.nextItemIndex, 1);
  assert.equal(recovered.state.outcomes.length, 1);
  assert.equal(recovered.state.outcomes[0]?.outcome, "failed");
  assert.equal(recovered.progress.productsFailed, 1);
});

test("terminal per-item outcome is skipped without a second refresh or metric increment", async () => {
  const state: PendingReviewBatchState = {
    batchSize: 25,
    selectedQueueItemIds: ["already-done"],
    sourceIds: ["dropex"],
    nextItemIndex: 0,
    inFlightQueueItemId: null,
    inFlightStartedAt: null,
    outcomes: [{ queueItemId: "already-done", outcome: "ready_to_publish", readyToPublish: true }],
  };
  let refreshCalls = 0;
  const result = await processPendingReviewRefreshJob(jobFor(state), {
    workerId: "worker-terminal",
    leaseId: "lease-terminal",
    revalidateItem: async () => { throw new Error("terminal outcome must be skipped before revalidation"); },
    refreshItem: async () => { refreshCalls += 1; throw new Error("must not refresh terminal outcome"); },
    updateProgress: async () => undefined,
    now: () => 1_000,
  });
  assert.equal(refreshCalls, 0);
  assert.equal(result.state.nextItemIndex, 1);
  assert.equal(result.state.outcomes.length, 1);
  assert.equal(result.progress.productsQueued, 1);
});

test("pending review polling continues only for active jobs and cleanup clears a timer", () => {
  assert.equal(pendingReviewBatchPollDelayMs({ state: "pending" }), 2_000);
  assert.equal(pendingReviewBatchPollDelayMs({ state: "running" }), 2_000);
  assert.equal(pendingReviewBatchPollDelayMs({ state: "waiting" }), 2_000);
  for (const state of ["completed", "failed", "cancelled", "unknown"]) assert.equal(pendingReviewBatchPollDelayMs({ state }), null);
  const cleared: number[] = [];
  clearPendingReviewBatchPollTimer(42, (timer) => cleared.push(timer));
  clearPendingReviewBatchPollTimer(null, (timer) => cleared.push(timer));
  assert.deepEqual(cleared, [42]);
});

test("pending review batch admission and status endpoints enforce runtime admin auth", {
  skip: canRunPendingReviewBatchApi ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const suffix = randomUUID().slice(0, 8);
  const email = `pending-refresh-${suffix}@example.test`;
  const password = `Zyro-${randomUUID()}!`;
  const app = initializeApp({ apiKey: "demo-key", projectId: emulatorProjectId }, `pending-refresh-${suffix}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authEmulatorHost}`, { disableWarnings: true });
  const apiBase = `http://${functionsEmulatorHost}/${emulatorProjectId}/us-central1/api/api`;
  const post = (token?: string) => fetch(`${apiBase}/supplier-review-queue/refresh-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ limit: 25 }),
  });
  const status = (jobId: string, token?: string) => fetch(`${apiBase}/supplier-review-queue/refresh-batch/jobs/${jobId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  try {
    assert.equal((await post()).status, 401);
    const user = await createUserWithEmailAndPassword(auth, email, password);
    const ordinaryToken = await user.user.getIdToken();
    assert.equal((await post(ordinaryToken)).status, 403);
    assert.equal((await status("missing-job", ordinaryToken)).status, 403);

    await adminAuth.setCustomUserClaims(user.user.uid, { supplierHubAdmin: true });
    const adminToken = await user.user.getIdToken(true);
    const admitted = await post(adminToken);
    assert.equal(admitted.status, 202);
    const admittedBody = await admitted.json() as { success: boolean; jobId: string };
    assert.equal(admittedBody.success, true);
    assert.match(admittedBody.jobId, /^[A-Za-z0-9_-]+$/u);
    const jobStatus = await status(admittedBody.jobId, adminToken);
    assert.equal(jobStatus.status, 200);
    assert.equal((await jobStatus.json() as { success: boolean }).success, true);
  } finally {
    const uid = auth.currentUser?.uid;
    if (uid) await adminAuth.deleteUser(uid).catch(() => undefined);
    await deleteApp(app);
  }
});

test("legacy sync UI is not the batch workflow and the batch route returns an asynchronous 202 job", () => {
  const source = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.match(source, /postSupplierApi\('\/api\/supplier-review-queue\/refresh-batch', \{ limit: pendingReviewBatchSize \}\)/u);
  assert.match(source, /refresh-batch\/jobs\?limit=10/u);
  assert.match(source, /Refresh in progress/u);
  assert.match(routes, /app\.post\("\/api\/supplier-review-queue\/refresh-batch", requireSupplierHubAdmin/u);
  assert.match(routes, /res\.status\(202\)\.json/u);
  assert.match(routes, /startLocalSupplierSyncJob\(result\.job\.id\)/u);
  assert.match(routes, /app\.get\("\/api\/supplier-review-queue\/refresh-batch\/jobs/u);
  assert.doesNotMatch(routes, /refreshPendingSupplierReviewBatch\(req\.body/u);
  assert.match(source, /pendingReviewBatchPollDelayMs\(active\)/u);
  assert.match(source, /clearPendingReviewBatchPollTimer\(timer, window\.clearTimeout\)/u);
});
