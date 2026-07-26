import { randomUUID } from "node:crypto";
import { FieldValue, Firestore } from "firebase-admin/firestore";

export const SUPPLIER_SYNC_JOB_STATES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type SupplierSyncJobState = typeof SUPPLIER_SYNC_JOB_STATES[number];
export type SupplierSyncJobTrigger = "manual" | "scheduled";

export interface SupplierSyncJobProgress {
  phase: string;
  percent: number;
  completedSources: number;
  totalSources: number;
  currentSourceId: string | null;
  pagesProcessed: number;
  productsDiscovered: number;
  productsScanned: number;
  productsQueued: number;
  productsFailed: number;
  elapsedMs: number;
  etaMs: number | null;
  etaAt: string | null;
  updatedAt: string;
}

export interface SupplierSyncJobRecord extends Record<string, unknown> {
  id: string;
  state: SupplierSyncJobState;
  trigger: SupplierSyncJobTrigger;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  retryCount: number;
  retryLimit: number;
  resumeCount: number;
  requestedBy: { uid: string; email: string };
  progress: SupplierSyncJobProgress;
  leaseOwner?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  cancellationRequestedAt?: string;
  cancellationRequestedBy?: string;
}

export interface CreateSupplierSyncJobInput {
  trigger: SupplierSyncJobTrigger;
  sourceIds?: readonly string[];
  requestedBy?: { uid?: string; email?: string };
  dedupeKey?: string;
}

export interface SupplierSyncJobLease {
  job: SupplierSyncJobRecord;
  leaseId: string;
}

export interface SupplierSyncJobProgressInput {
  phase?: string;
  completedSources?: number;
  totalSources?: number;
  currentSourceId?: string | null;
  pagesProcessed?: number;
  productsDiscovered?: number;
  productsScanned?: number;
  productsQueued?: number;
  productsFailed?: number;
}

const DEFAULT_RETRY_LIMIT = 5;
export const SUPPLIER_SYNC_JOB_LEASE_MS = 2 * 60 * 1000;

const cleanCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

const cleanSourceIds = (sourceIds: readonly string[] = []): string[] => [...new Set(sourceIds
  .map((sourceId) => String(sourceId || "").trim())
  .filter((sourceId) => sourceId && !sourceId.includes("/") && sourceId.length <= 160))];

const toMillis = (value: unknown): number => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  return 0;
};

const stateFor = (value: unknown): SupplierSyncJobState => (
  (SUPPLIER_SYNC_JOB_STATES as readonly unknown[]).includes(value) ? value as SupplierSyncJobState : "pending"
);

const retryDelayMs = (attempt: number): number => Math.min(15 * 60 * 1000, 15_000 * (2 ** Math.max(0, attempt - 1)));

export function calculateSupplierSyncJobProgress(
  startedAtMs: number,
  input: SupplierSyncJobProgressInput,
  now = Date.now(),
): SupplierSyncJobProgress {
  const totalSources = cleanCount(input.totalSources);
  const completedSources = Math.min(cleanCount(input.completedSources), totalSources || Number.MAX_SAFE_INTEGER);
  const elapsedMs = Math.max(0, now - startedAtMs);
  const fraction = totalSources > 0 ? Math.min(1, completedSources / totalSources) : 0;
  const percent = input.phase === "completed" ? 100 : Math.min(99, Math.max(0, Math.round(fraction * 100)));
  const etaMs = fraction > 0 && fraction < 1 ? Math.max(0, Math.round((elapsedMs / fraction) - elapsedMs)) : null;
  return {
    phase: String(input.phase || "pending"),
    percent,
    completedSources,
    totalSources,
    currentSourceId: input.currentSourceId ? String(input.currentSourceId) : null,
    pagesProcessed: cleanCount(input.pagesProcessed),
    productsDiscovered: cleanCount(input.productsDiscovered),
    productsScanned: cleanCount(input.productsScanned),
    productsQueued: cleanCount(input.productsQueued),
    productsFailed: cleanCount(input.productsFailed),
    elapsedMs,
    etaMs,
    etaAt: etaMs === null ? null : new Date(now + etaMs).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export function canLeaseSupplierSyncJob(record: Record<string, unknown>, now = Date.now()): boolean {
  const state = stateFor(record.state);
  if (state !== "pending" && state !== "waiting") return false;
  return toMillis(record.nextAttemptAt) <= now;
}

export function canTransitionSupplierSyncJob(from: SupplierSyncJobState, to: SupplierSyncJobState): boolean {
  const transitions: Record<SupplierSyncJobState, readonly SupplierSyncJobState[]> = {
    pending: ["running", "cancelled"],
    running: ["waiting", "completed", "failed", "cancelled"],
    waiting: ["pending", "running", "failed", "cancelled"],
    completed: [],
    failed: ["pending"],
    cancelled: ["pending"],
  };
  return transitions[from].includes(to);
}

const initialProgress = (now: number): SupplierSyncJobProgress => calculateSupplierSyncJobProgress(now, { phase: "pending" }, now);

export async function createSupplierSyncJob(
  db: Firestore,
  input: CreateSupplierSyncJobInput,
  now = Date.now(),
): Promise<{ created: boolean; job: SupplierSyncJobRecord }> {
  const requestedId = String(input.dedupeKey || "").trim();
  const reference = requestedId
    ? db.collection("supplier_sync_jobs").doc(requestedId)
    : db.collection("supplier_sync_jobs").doc();
  const createdAt = new Date(now).toISOString();
  const record: SupplierSyncJobRecord = {
    id: reference.id,
    schemaVersion: 1,
    state: "pending",
    trigger: input.trigger,
    sourceIds: cleanSourceIds(input.sourceIds),
    requestedBy: {
      uid: String(input.requestedBy?.uid || (input.trigger === "scheduled" ? "system" : "unknown")).slice(0, 160),
      email: String(input.requestedBy?.email || "").slice(0, 320),
    },
    createdAt,
    updatedAt: createdAt,
    nextAttemptAt: createdAt,
    retryCount: 0,
    retryLimit: DEFAULT_RETRY_LIMIT,
    resumeCount: 0,
    progress: initialProgress(now),
  };
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists) {
      return { created: false, job: { id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord };
    }
    transaction.create(reference, record);
    return { created: true, job: record };
  });
}

export async function leaseSupplierSyncJob(
  db: Firestore,
  jobId: string,
  workerId: string,
  now = Date.now(),
  leaseMs = SUPPLIER_SYNC_JOB_LEASE_MS,
): Promise<SupplierSyncJobLease | null> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const record = { id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord;
    if (!canLeaseSupplierSyncJob(record, now)) return null;
    const leaseId = `${workerId}:${randomUUID()}`;
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : new Date(now).toISOString();
    transaction.set(reference, {
      state: "running" satisfies SupplierSyncJobState,
      startedAt,
      lastStartedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      leaseOwner: workerId,
      leaseId,
      leaseAcquiredAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      heartbeatCount: cleanCount(record.heartbeatCount),
      attemptCount: cleanCount(record.attemptCount) + 1,
      progress: {
        ...(record.progress || initialProgress(now)),
        phase: "starting",
        updatedAt: new Date(now).toISOString(),
      },
    }, { merge: true });
    return { job: { ...record, state: "running", leaseOwner: workerId, leaseId }, leaseId };
  });
}

export async function heartbeatSupplierSyncJob(
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  progress: SupplierSyncJobProgress,
  now = Date.now(),
  leaseMs = SUPPLIER_SYNC_JOB_LEASE_MS,
): Promise<{ cancellationRequested: boolean }> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() || {};
    if (!snapshot.exists || stateFor(data.state) !== "running" || data.leaseOwner !== workerId || data.leaseId !== leaseId) {
      throw new Error("Supplier sync job lease is no longer owned by this worker.");
    }
    const cancellationRequested = Boolean(data.cancellationRequestedAt);
    transaction.set(reference, {
      progress,
      lastHeartbeatAt: new Date(now).toISOString(),
      heartbeatCount: cleanCount(data.heartbeatCount) + 1,
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
    return { cancellationRequested };
  });
}

async function finishOwnedSupplierSyncJob(
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  state: "waiting" | "completed" | "failed" | "cancelled",
  patch: Record<string, unknown>,
  now: number,
): Promise<boolean> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() || {};
    if (!snapshot.exists || stateFor(data.state) !== "running" || data.leaseOwner !== workerId || data.leaseId !== leaseId) return false;
    transaction.set(reference, {
      state,
      ...patch,
      updatedAt: new Date(now).toISOString(),
      leaseOwner: FieldValue.delete(),
      leaseId: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    }, { merge: true });
    return true;
  });
}

export const completeSupplierSyncJob = (
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  result: Record<string, unknown>,
  progress: SupplierSyncJobProgress,
  now = Date.now(),
): Promise<boolean> => finishOwnedSupplierSyncJob(db, jobId, workerId, leaseId, "completed", {
  result,
  progress: { ...progress, phase: "completed", percent: 100, etaMs: 0, etaAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
  completedAt: new Date(now).toISOString(),
  finishedAt: new Date(now).toISOString(),
  lastFailureReason: FieldValue.delete(),
}, now);

export const cancelRunningSupplierSyncJob = (
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  progress: SupplierSyncJobProgress,
  now = Date.now(),
): Promise<boolean> => finishOwnedSupplierSyncJob(db, jobId, workerId, leaseId, "cancelled", {
  progress: { ...progress, phase: "cancelled", etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() },
  cancelledAt: new Date(now).toISOString(),
  finishedAt: new Date(now).toISOString(),
}, now);

export const waitSupplierSyncJob = (
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  progress: SupplierSyncJobProgress,
  reason: string,
  now = Date.now(),
): Promise<boolean> => finishOwnedSupplierSyncJob(db, jobId, workerId, leaseId, "waiting", {
  progress: { ...progress, phase: "waiting", etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() },
  waitingReason: reason.slice(0, 1_000),
  waitingAt: new Date(now).toISOString(),
  nextAttemptAt: new Date(now + 15_000).toISOString(),
  resumeCount: FieldValue.increment(1),
}, now);

export async function failSupplierSyncJob(
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  progress: SupplierSyncJobProgress,
  error: unknown,
  now = Date.now(),
): Promise<boolean> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() || {};
    if (!snapshot.exists || stateFor(data.state) !== "running" || data.leaseOwner !== workerId || data.leaseId !== leaseId) return false;
    const retryCount = cleanCount(data.retryCount) + 1;
    const retryLimit = Math.max(1, cleanCount(data.retryLimit) || DEFAULT_RETRY_LIMIT);
    const terminal = retryCount >= retryLimit;
    const message = error instanceof Error ? error.message : String(error || "Supplier synchronization failed.");
    transaction.set(reference, {
      state: terminal ? "failed" : "waiting",
      retryCount,
      lastFailureAt: new Date(now).toISOString(),
      lastFailureReason: message.slice(0, 1_000),
      nextAttemptAt: terminal ? FieldValue.delete() : new Date(now + retryDelayMs(retryCount)).toISOString(),
      progress: { ...progress, phase: terminal ? "failed" : "waiting", etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() },
      ...(terminal ? { failedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString() } : { waitingAt: new Date(now).toISOString() }),
      updatedAt: new Date(now).toISOString(),
      leaseOwner: FieldValue.delete(),
      leaseId: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    }, { merge: true });
    return true;
  });
}

export async function requestSupplierSyncJobCancellation(
  db: Firestore,
  jobId: string,
  actorId: string,
  now = Date.now(),
): Promise<SupplierSyncJobRecord | null> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const record = { id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord;
    const state = stateFor(record.state);
    if (!["pending", "running", "waiting"].includes(state)) return record;
    const patch = state === "running" ? {
      cancellationRequestedAt: new Date(now).toISOString(),
      cancellationRequestedBy: actorId,
      updatedAt: new Date(now).toISOString(),
    } : {
      state: "cancelled" satisfies SupplierSyncJobState,
      cancellationRequestedAt: new Date(now).toISOString(),
      cancellationRequestedBy: actorId,
      cancelledAt: new Date(now).toISOString(),
      finishedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      progress: { ...(record.progress || initialProgress(now)), phase: "cancelled", etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() },
    };
    transaction.set(reference, patch, { merge: true });
    return { ...record, ...patch } as SupplierSyncJobRecord;
  });
}

export async function requeueSupplierSyncJob(
  db: Firestore,
  jobId: string,
  action: "retry" | "resume",
  actorId: string,
  now = Date.now(),
): Promise<SupplierSyncJobRecord | null> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const record = { id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord;
    const state = stateFor(record.state);
    const allowed = action === "retry" ? state === "failed" : (state === "waiting" || state === "cancelled");
    if (!allowed) return record;
    const patch: Record<string, unknown> = {
      state: "pending" satisfies SupplierSyncJobState,
      nextAttemptAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      lastRequestedAction: action,
      lastRequestedBy: actorId,
      cancellationRequestedAt: FieldValue.delete(),
      cancellationRequestedBy: FieldValue.delete(),
      finishedAt: FieldValue.delete(),
      progress: { ...(record.progress || initialProgress(now)), phase: "pending", etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() },
      ...(action === "retry" ? { retryRequestedAt: new Date(now).toISOString(), retryCount: 0 } : {
        resumeRequestedAt: new Date(now).toISOString(),
        resumeCount: cleanCount(record.resumeCount) + 1,
      }),
    };
    transaction.set(reference, patch, { merge: true });
    const nextRecord = { ...record, ...patch } as SupplierSyncJobRecord;
    delete nextRecord.cancellationRequestedAt;
    delete nextRecord.cancellationRequestedBy;
    delete nextRecord.finishedAt;
    return nextRecord;
  });
}

export async function recoverExpiredSupplierSyncJobs(db: Firestore, now = Date.now(), limit = 50): Promise<number> {
  const snapshot = await db.collection("supplier_sync_jobs")
    .where("state", "==", "running")
    .where("leaseExpiresAt", "<=", new Date(now).toISOString())
    .orderBy("leaseExpiresAt", "asc")
    .orderBy("createdAt", "asc")
    .limit(Math.max(1, Math.min(limit, 100)))
    .get();
  let recovered = 0;
  for (const document of snapshot.docs) {
    const changed = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(document.ref);
      const data = current.data() || {};
      if (stateFor(data.state) !== "running" || toMillis(data.leaseExpiresAt) > now) return false;
      const retryCount = cleanCount(data.retryCount) + 1;
      const retryLimit = Math.max(1, cleanCount(data.retryLimit) || DEFAULT_RETRY_LIMIT);
      const terminal = retryCount >= retryLimit;
      transaction.set(document.ref, {
        state: terminal ? "failed" : "waiting",
        retryCount,
        lastFailureAt: new Date(now).toISOString(),
        lastFailureReason: "Worker lease expired before synchronization completed.",
        nextAttemptAt: terminal ? FieldValue.delete() : new Date(now + retryDelayMs(retryCount)).toISOString(),
        ...(terminal ? { failedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString() } : { waitingAt: new Date(now).toISOString() }),
        progress: { ...(data.progress as Record<string, unknown> || {}), phase: terminal ? "failed" : "waiting", etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() },
        leaseOwner: FieldValue.delete(),
        leaseId: FieldValue.delete(),
        leaseAcquiredAt: FieldValue.delete(),
        leaseExpiresAt: FieldValue.delete(),
        recoveredAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }, { merge: true });
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}

export async function listDueSupplierSyncJobIds(db: Firestore, now = Date.now(), limit = 25): Promise<string[]> {
  const snapshot = await db.collection("supplier_sync_jobs")
    .where("state", "in", ["pending", "waiting"])
    .where("nextAttemptAt", "<=", new Date(now).toISOString())
    .orderBy("nextAttemptAt", "asc")
    .orderBy("createdAt", "asc")
    .limit(Math.max(1, Math.min(limit, 50)))
    .get();
  return snapshot.docs.map((document) => document.id);
}

export async function listSupplierSyncJobs(db: Firestore, limit = 20): Promise<SupplierSyncJobRecord[]> {
  const snapshot = await db.collection("supplier_sync_jobs")
    .orderBy("createdAt", "desc")
    .limit(Math.max(1, Math.min(limit, 100)))
    .get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as SupplierSyncJobRecord);
}

export function projectSupplierSyncJobForAdmin(job: SupplierSyncJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    state: stateFor(job.state),
    trigger: job.trigger,
    sourceIds: cleanSourceIds(job.sourceIds),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    nextAttemptAt: job.nextAttemptAt || null,
    retryCount: cleanCount(job.retryCount),
    retryLimit: cleanCount(job.retryLimit),
    resumeCount: cleanCount(job.resumeCount),
    cancellationRequestedAt: job.cancellationRequestedAt || null,
    progress: job.progress || initialProgress(Date.now()),
    result: job.result || null,
    lastFailureReason: job.lastFailureReason || null,
    waitingReason: job.waitingReason || null,
  };
}
