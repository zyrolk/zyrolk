import { randomUUID } from "node:crypto";
import { FieldValue, Firestore, Transaction } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { recordSupplierManualSyncRequestMetric } from "./supplierCloudMonitoring";
import { fingerprintSupplierSyncRequest, SupplierSyncRequest } from "./supplierSyncRequest";

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
export type SupplierSyncProgressDetermination = "determinate" | "indeterminate";
export type SupplierSyncProgressBasis = "catalog_total" | "limit_upper_bound" | "unknown" | "completed";
export type SupplierSyncProgressTotalReliability = "exact" | "reported" | "unknown";

export interface SupplierSyncJobProgress {
  modelVersion: 2;
  determination: SupplierSyncProgressDetermination;
  basis: SupplierSyncProgressBasis;
  phase: string;
  percent: number;
  completedSources: number;
  totalSources: number;
  currentSourceId: string | null;
  pagesProcessed: number;
  productsDiscovered: number;
  productsObserved: number;
  productsScanned: number;
  productsQueued: number;
  productsFailed: number;
  totalProducts: number | null;
  totalProductsReliability: SupplierSyncProgressTotalReliability;
  elapsedMs: number;
  activeElapsedMs: number;
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
  syncRequest?: SupplierSyncRequest;
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
  syncRequest?: SupplierSyncRequest;
}

export interface SupplierSyncJobAdmissionConflict {
  sourceId: string;
  jobId: string;
  state: SupplierSyncJobState;
}

export class SupplierSyncJobConflictError extends ApiError {
  readonly code = "supplier_sync_job_conflict";

  constructor(readonly conflicts: SupplierSyncJobAdmissionConflict[]) {
    super(
      "One or more supplier sources already have an active synchronization job.",
      409,
      "One or more selected suppliers are already synchronizing.",
      { code: "supplier_sync_job_conflict", conflicts },
    );
    this.name = "SupplierSyncJobConflictError";
  }
}

export interface CreateSupplierSyncJobResult {
  created: boolean;
  deduplicated: boolean;
  job: SupplierSyncJobRecord;
}

export interface SupplierSyncJobLease {
  job: SupplierSyncJobRecord;
  leaseId: string;
}

export interface SupplierSyncJobProgressInput {
  modelVersion?: number;
  determination?: SupplierSyncProgressDetermination;
  basis?: SupplierSyncProgressBasis;
  phase?: string;
  completedSources?: number;
  totalSources?: number;
  currentSourceId?: string | null;
  pagesProcessed?: number;
  productsDiscovered?: number;
  productsObserved?: number;
  productsScanned?: number;
  productsQueued?: number;
  productsFailed?: number;
  totalProducts?: number | null;
  totalProductsReliability?: SupplierSyncProgressTotalReliability;
  activeElapsedMs?: number;
}

const DEFAULT_RETRY_LIMIT = 5;
export const SUPPLIER_SYNC_JOB_LEASE_MS = 2 * 60 * 1000;
const ACTIVE_SYNC_JOB_STATES = new Set<SupplierSyncJobState>(["pending", "running", "waiting"]);
const MANUAL_RESERVATION_JOB_FIELD = "manualReservationJobId";

const cleanCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

const cleanOptionalCount = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const progressTotalReliability = (value: unknown): SupplierSyncProgressTotalReliability => (
  value === "exact" || value === "reported" ? value : "unknown"
);

const progressBasis = (value: unknown): SupplierSyncProgressBasis => (
  value === "catalog_total" || value === "limit_upper_bound" || value === "completed" ? value : "unknown"
);

const cleanSourceIds = (sourceIds: readonly string[] = []): string[] => [...new Set(sourceIds
  .map((sourceId) => String(sourceId || "").trim())
  .filter((sourceId) => sourceId && !sourceId.includes("/") && sourceId.length <= 160))]
  .sort((left, right) => left.localeCompare(right));

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

const isActiveSupplierSyncJob = (value: Record<string, unknown>): boolean => ACTIVE_SYNC_JOB_STATES.has(stateFor(value.state));

const sameSourceScope = (left: readonly string[], right: readonly string[]): boolean => {
  const leftIds = cleanSourceIds(left);
  const rightIds = cleanSourceIds(right);
  return leftIds.length === rightIds.length && leftIds.every((sourceId, index) => sourceId === rightIds[index]);
};

const sameSyncRequest = (left?: SupplierSyncRequest, right?: SupplierSyncRequest): boolean => (
  fingerprintSupplierSyncRequest(left || { mode: "full" })
  === fingerprintSupplierSyncRequest(right || { mode: "full" })
);

const manualReservationPatch = (jobId: string, sourceIds: readonly string[], now: number): Record<string, unknown> => ({
  [MANUAL_RESERVATION_JOB_FIELD]: jobId,
  manualReservationSourceIds: cleanSourceIds(sourceIds),
  manualReservationTrigger: "manual",
  manualReservationUpdatedAt: new Date(now).toISOString(),
});

const clearManualReservationPatch = (): Record<string, unknown> => ({
  [MANUAL_RESERVATION_JOB_FIELD]: FieldValue.delete(),
  manualReservationSourceIds: FieldValue.delete(),
  manualReservationTrigger: FieldValue.delete(),
  manualReservationCreatedAt: FieldValue.delete(),
  manualReservationUpdatedAt: FieldValue.delete(),
});

async function clearOwnedManualReservations(
  db: Firestore,
  transaction: Transaction,
  job: Pick<SupplierSyncJobRecord, "id" | "trigger" | "sourceIds">,
): Promise<void> {
  if (job.trigger !== "manual") return;
  const sourceIds = cleanSourceIds(job.sourceIds);
  const references = sourceIds.map((sourceId) => db.collection("supplier_sync_locks").doc(`source-${sourceId}`));
  const snapshots = await Promise.all(references.map((reference) => transaction.get(reference)));
  snapshots.forEach((snapshot, index) => {
    if (snapshot.data()?.[MANUAL_RESERVATION_JOB_FIELD] !== job.id) return;
    transaction.set(references[index], clearManualReservationPatch(), { merge: true });
  });
}

async function reserveExistingManualJob(
  db: Firestore,
  transaction: Transaction,
  job: SupplierSyncJobRecord,
  now: number,
): Promise<boolean> {
  if (job.trigger !== "manual") return true;
  const sourceIds = cleanSourceIds(job.sourceIds);
  if (sourceIds.length === 0) return true;
  const references = sourceIds.map((sourceId) => db.collection("supplier_sync_locks").doc(`source-${sourceId}`));
  const snapshots = await Promise.all(references.map((reference) => transaction.get(reference)));
  const hasDifferentExecutionOwner = snapshots.some((snapshot) => {
    const lock = snapshot.data() || {};
    const owner = String(lock.owner || "").trim();
    return lock.status === "running" && toMillis(lock.lockedUntil) > now && owner && owner !== job.id;
  });
  if (hasDifferentExecutionOwner) return false;
  const otherJobIds = [...new Set(snapshots
    .map((snapshot) => String(snapshot.data()?.[MANUAL_RESERVATION_JOB_FIELD] || "").trim())
    .filter((jobId) => jobId && jobId !== job.id))];
  const otherJobSnapshots = await Promise.all(otherJobIds
    .map((jobId) => transaction.get(db.collection("supplier_sync_jobs").doc(jobId))));
  if (otherJobSnapshots.some((snapshot) => snapshot.exists && isActiveSupplierSyncJob(snapshot.data() || {}))) return false;
  references.forEach((reference, index) => transaction.set(reference, {
    ...manualReservationPatch(job.id, sourceIds, now),
    sourceId: sourceIds[index],
    manualReservationCreatedAt: new Date(now).toISOString(),
  }, { merge: true }));
  return true;
}

const retryDelayMs = (attempt: number): number => Math.min(15 * 60 * 1000, 15_000 * (2 ** Math.max(0, attempt - 1)));

export function calculateSupplierSyncJobProgress(
  startedAtMs: number,
  input: SupplierSyncJobProgressInput,
  now = Date.now(),
): SupplierSyncJobProgress {
  const phase = String(input.phase || "pending");
  const totalSources = cleanCount(input.totalSources);
  const completedSources = Math.min(cleanCount(input.completedSources), totalSources || Number.MAX_SAFE_INTEGER);
  const elapsedMs = Math.max(0, now - startedAtMs);
  const activeElapsedMs = input.activeElapsedMs === undefined ? elapsedMs : cleanCount(input.activeElapsedMs);
  const productsDiscovered = cleanCount(input.productsDiscovered ?? input.productsObserved);
  const productsObserved = cleanCount(input.productsObserved ?? input.productsDiscovered);
  const requestedTotalProducts = cleanOptionalCount(input.totalProducts);
  const requestedReliability = progressTotalReliability(input.totalProductsReliability);
  const totalIsConsistent = requestedTotalProducts !== null && productsObserved <= requestedTotalProducts;
  const totalProductsReliability = requestedReliability === "exact" && !totalIsConsistent
    ? "reported"
    : requestedReliability;
  const terminallyCompleted = phase === "completed";
  const hasExactTotal = !terminallyCompleted
    && input.determination !== "indeterminate"
    && totalProductsReliability === "exact"
    && requestedTotalProducts !== null
    && requestedTotalProducts > 0;
  const determination: SupplierSyncProgressDetermination = terminallyCompleted || hasExactTotal
    ? "determinate"
    : "indeterminate";
  const basis: SupplierSyncProgressBasis = terminallyCompleted
    ? "completed"
    : progressBasis(input.basis) === "catalog_total" && requestedTotalProducts !== null
      ? "catalog_total"
      : progressBasis(input.basis);
  const fraction = hasExactTotal && requestedTotalProducts
    ? Math.min(1, productsObserved / requestedTotalProducts)
    : 0;
  const percent = terminallyCompleted ? 100 : hasExactTotal
    ? Math.min(99, Math.max(0, Math.round(fraction * 100)))
    : 0;
  const etaMs = terminallyCompleted
    ? 0
    : hasExactTotal && fraction > 0 && fraction < 1 && activeElapsedMs > 0
      ? Math.max(0, Math.round((activeElapsedMs / fraction) - activeElapsedMs))
      : null;
  return {
    modelVersion: 2,
    determination,
    basis,
    phase,
    percent,
    completedSources,
    totalSources,
    currentSourceId: input.currentSourceId ? String(input.currentSourceId) : null,
    pagesProcessed: cleanCount(input.pagesProcessed),
    productsDiscovered,
    productsObserved,
    productsScanned: cleanCount(input.productsScanned),
    productsQueued: cleanCount(input.productsQueued),
    productsFailed: cleanCount(input.productsFailed),
    totalProducts: requestedTotalProducts,
    totalProductsReliability,
    elapsedMs,
    activeElapsedMs,
    etaMs,
    etaAt: etaMs === null ? null : new Date(now + etaMs).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Projects legacy and current jobs through one truthful progress contract.
 * Legacy source-count percentages and ETAs are intentionally not trusted.
 */
export function normalizeSupplierSyncJobProgress(
  job: SupplierSyncJobRecord | Record<string, unknown>,
  now = Date.now(),
): SupplierSyncJobProgress {
  const raw = job.progress && typeof job.progress === "object" && !Array.isArray(job.progress)
    ? job.progress as Record<string, unknown>
    : {};
  const state = stateFor(job.state);
  const isCurrentModel = Number(raw.modelVersion) === 2;
  const progressAtMs = toMillis(raw.updatedAt) || toMillis(job.updatedAt) || toMillis(job.finishedAt) || now;
  const startedAtMs = toMillis(job.startedAt) || toMillis(job.createdAt) || progressAtMs;
  const phase = state === "completed" ? "completed" : String(raw.phase || state || "pending");
  return calculateSupplierSyncJobProgress(startedAtMs, {
    ...raw,
    phase,
    determination: isCurrentModel
      ? raw.determination as SupplierSyncProgressDetermination
      : "indeterminate",
    basis: state === "completed"
      ? "completed"
      : isCurrentModel ? raw.basis as SupplierSyncProgressBasis : "unknown",
    productsObserved: cleanCount(raw.productsObserved ?? raw.productsDiscovered),
    totalProducts: isCurrentModel ? cleanOptionalCount(raw.totalProducts) : null,
    totalProductsReliability: isCurrentModel
      ? progressTotalReliability(raw.totalProductsReliability)
      : "unknown",
    activeElapsedMs: isCurrentModel ? cleanCount(raw.activeElapsedMs) : 0,
  }, progressAtMs);
}

/** Adds the current worker attempt's committed counters to durable job totals. */
export function accumulateSupplierSyncAttemptProgress(
  base: Pick<SupplierSyncJobProgress,
    "pagesProcessed" | "productsDiscovered" | "productsObserved" | "productsScanned" | "productsQueued" | "productsFailed">,
  attempt: SupplierSyncJobProgressInput,
): SupplierSyncJobProgressInput {
  const cumulative: SupplierSyncJobProgressInput = { ...attempt };
  const counters = [
    "pagesProcessed",
    "productsDiscovered",
    "productsObserved",
    "productsScanned",
    "productsQueued",
    "productsFailed",
  ] as const;
  counters.forEach((field) => {
    if (!Object.hasOwn(attempt, field)) return;
    cumulative[field] = base[field] + cleanCount(attempt[field]);
  });
  return cumulative;
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
): Promise<CreateSupplierSyncJobResult> {
  const requestedId = String(input.dedupeKey || "").trim();
  const reference = requestedId
    ? db.collection("supplier_sync_jobs").doc(requestedId)
    : db.collection("supplier_sync_jobs").doc();
  const createdAt = new Date(now).toISOString();
  const sourceIds = cleanSourceIds(input.sourceIds);
  const record: SupplierSyncJobRecord = {
    id: reference.id,
    schemaVersion: 1,
    state: "pending",
    trigger: input.trigger,
    sourceIds,
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
    ...(input.syncRequest ? { syncRequest: input.syncRequest } : {}),
  };
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);

    // Scheduled jobs retain their existing minute-bucket document identity. A
    // manual request without an explicit source scope is a legacy all-sources
    // request and must be resolved by the API before source-level admission can
    // be guaranteed.
    if (input.trigger !== "manual" || sourceIds.length === 0) {
      if (snapshot.exists) {
        return {
          created: false,
          deduplicated: true,
          job: { id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord,
        };
      }
      transaction.create(reference, record);
      return { created: true, deduplicated: false, job: record };
    }

    const lockReferences = sourceIds.map((sourceId) => db.collection("supplier_sync_locks").doc(`source-${sourceId}`));
    const lockSnapshots = await Promise.all(lockReferences.map((lockReference) => transaction.get(lockReference)));
    const executionOwnerIds = lockSnapshots.map((lockSnapshot) => {
      const lock = lockSnapshot.data() || {};
      return lock.status === "running" && toMillis(lock.lockedUntil) > now
        ? String(lock.owner || "").trim()
        : "";
    });
    const reservationOwnerIds = lockSnapshots
      .map((lockSnapshot) => String(lockSnapshot.data()?.[MANUAL_RESERVATION_JOB_FIELD] || "").trim());
    const reservationJobIds = [...new Set([...reservationOwnerIds, ...executionOwnerIds].filter(Boolean))];
    const reservationJobReferences = reservationJobIds.map((jobId) => db.collection("supplier_sync_jobs").doc(jobId));
    const reservationJobSnapshots = await Promise.all(reservationJobReferences.map((jobReference) => transaction.get(jobReference)));
    const activeJobs = new Map<string, SupplierSyncJobRecord>();
    reservationJobSnapshots.forEach((jobSnapshot) => {
      if (!jobSnapshot.exists) return;
      const job = { id: jobSnapshot.id, ...jobSnapshot.data() } as SupplierSyncJobRecord;
      if (isActiveSupplierSyncJob(job)) activeJobs.set(job.id, job);
    });

    const existingRequestedJob = snapshot.exists
      ? { id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord
      : null;
    if (existingRequestedJob && isActiveSupplierSyncJob(existingRequestedJob)) {
      activeJobs.set(existingRequestedJob.id, existingRequestedJob);
    }

    const conflicts = lockSnapshots.flatMap((_lockSnapshot, index): SupplierSyncJobAdmissionConflict[] => {
      const candidateJobIds = [...new Set([
        reservationOwnerIds[index],
        executionOwnerIds[index],
      ].filter(Boolean))];
      return candidateJobIds.flatMap((jobId) => {
        const job = activeJobs.get(jobId);
        if (job) return [{ sourceId: sourceIds[index], jobId, state: stateFor(job.state) }];
        // A still-valid source execution lock must fail closed even if its job
        // document predates durable jobs or is temporarily unavailable.
        return executionOwnerIds[index] === jobId
          ? [{ sourceId: sourceIds[index], jobId, state: "running" as const }]
          : [];
      });
    });
    const conflictJobIds = [...new Set(conflicts.map((conflict) => conflict.jobId))];
    const reusableJob = conflictJobIds.length === 1 ? activeJobs.get(conflictJobIds[0]) : existingRequestedJob;

    if (
      reusableJob
      && reusableJob.trigger === "manual"
      && isActiveSupplierSyncJob(reusableJob)
      && sameSourceScope(reusableJob.sourceIds, sourceIds)
      && sameSyncRequest(reusableJob.syncRequest, input.syncRequest)
      && conflicts.every((conflict) => conflict.jobId === reusableJob.id)
    ) {
      lockReferences.forEach((lockReference, index) => transaction.set(lockReference, {
        ...manualReservationPatch(reusableJob.id, sourceIds, now),
        sourceId: sourceIds[index],
      }, { merge: true }));
      return { created: false, deduplicated: true, job: reusableJob };
    }

    if (conflicts.length > 0) {
      throw new SupplierSyncJobConflictError([...conflicts]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.jobId.localeCompare(right.jobId)));
    }

    // An explicit dedupe key retains its historical idempotency contract even
    // after the job becomes terminal. Ordinary manual requests use random job
    // IDs and therefore reach this branch only for a new request.
    if (existingRequestedJob) {
      return { created: false, deduplicated: true, job: existingRequestedJob };
    }

    transaction.create(reference, record);
    lockReferences.forEach((lockReference, index) => transaction.set(lockReference, {
      ...manualReservationPatch(record.id, sourceIds, now),
      sourceId: sourceIds[index],
      manualReservationCreatedAt: createdAt,
    }, { merge: true }));
    return { created: true, deduplicated: false, job: record };
  });
  if (input.trigger === "manual") {
    recordSupplierManualSyncRequestMetric({
      jobId: result.job.id,
      sourceCount: record.sourceIds.length,
      created: result.created,
    });
  }
  return result;
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
    if (!await reserveExistingManualJob(db, transaction, record, now)) return null;
    const leaseId = `${workerId}:${randomUUID()}`;
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : new Date(now).toISOString();
    const progress = {
      ...normalizeSupplierSyncJobProgress({ ...record, startedAt }, now),
      phase: "starting",
      updatedAt: new Date(now).toISOString(),
    };
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
      progress,
    }, { merge: true });
    return {
      job: {
        ...record,
        state: "running",
        startedAt,
        updatedAt: new Date(now).toISOString(),
        progress,
        leaseOwner: workerId,
        leaseId,
      },
      leaseId,
    };
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
    const job = { id: snapshot.id, ...data } as SupplierSyncJobRecord;
    if (state !== "waiting") await clearOwnedManualReservations(db, transaction, job);
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
  progress: {
    ...progress,
    determination: "determinate",
    basis: "completed",
    phase: "completed",
    percent: 100,
    etaMs: 0,
    etaAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  },
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
    if (terminal) {
      await clearOwnedManualReservations(db, transaction, { id: snapshot.id, ...data } as SupplierSyncJobRecord);
    }
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
    if (state !== "running") await clearOwnedManualReservations(db, transaction, record);
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
    if (!await reserveExistingManualJob(db, transaction, record, now)) return record;
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
      if (terminal) {
        await clearOwnedManualReservations(db, transaction, { id: current.id, ...data } as SupplierSyncJobRecord);
      }
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
    syncRequest: job.syncRequest || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    nextAttemptAt: job.nextAttemptAt || null,
    retryCount: cleanCount(job.retryCount),
    retryLimit: cleanCount(job.retryLimit),
    resumeCount: cleanCount(job.resumeCount),
    cancellationRequestedAt: job.cancellationRequestedAt || null,
    progress: normalizeSupplierSyncJobProgress(job),
    result: job.result || null,
    lastFailureReason: job.lastFailureReason || null,
    waitingReason: job.waitingReason || null,
  };
}
