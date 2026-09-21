import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { adminDb } from "../firebase";
import {
  createSupplierSyncJob,
  SupplierSyncJobRecord,
  SupplierSyncJobProgress,
  updatePendingReviewRefreshJobProgress,
} from "./supplierSyncJobs";
import { refreshActiveSupplierReviewItem, SupplierReviewRefreshResult } from "../../scheduled/supplierSync";
import { reviewRecordIsRefreshable } from "../../scheduled/supplierReviewQueue";

export const PENDING_REVIEW_BATCH_JOB_TYPE = "pending_review_refresh" as const;
export const PENDING_REVIEW_BATCH_SIZES = [25, 50, 100] as const;
export type PendingReviewBatchSize = typeof PENDING_REVIEW_BATCH_SIZES[number];
export type PendingReviewBatchOutcome = "refreshed" | "ready_to_publish" | "still_blocked" | "unchanged" | "supplier_not_found" | "failed";
export type PendingReviewBatchItemOutcome = {
  queueItemId: string;
  outcome: PendingReviewBatchOutcome;
  readyToPublish?: boolean;
  unchanged?: boolean;
  error?: string;
  completedAt?: string;
};
export type PendingReviewBatchState = {
  batchSize: PendingReviewBatchSize;
  selectedQueueItemIds: string[];
  sourceIds: string[];
  nextItemIndex: number;
  inFlightQueueItemId: string | null;
  inFlightStartedAt: string | null;
  outcomes: PendingReviewBatchItemOutcome[];
};

type Reviewer = { uid: string; email: string };
type SupplierReviewRefresh = (queueItemId: string, reviewer?: Reviewer) => Promise<SupplierReviewRefreshResult>;
type JobCreator = typeof createSupplierSyncJob;

export interface PendingReviewBatchRefreshResult {
  jobId: string;
  state: string;
  batchSize: PendingReviewBatchSize;
  selected: number;
  attempted: number;
  completed: number;
  refreshedSuccessfully: number;
  nowReadyToPublish: number;
  stillBlocked: number;
  supplierRemovedOrNotFound: number;
  failed: number;
  unchanged: number;
  items: PendingReviewBatchItemOutcome[];
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastFailureReason?: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parsePendingReviewBatchSize(body: unknown): PendingReviewBatchSize {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "limit")) throw new ApiError("A pending review batch size is required.", 400);
  const value = body.limit;
  if (typeof value !== "number" || !Number.isInteger(value) || !PENDING_REVIEW_BATCH_SIZES.includes(value as PendingReviewBatchSize)) {
    throw new ApiError("Pending review batch size must be 25, 50, or 100.", 400);
  }
  return value as PendingReviewBatchSize;
}

const timestampMillis = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  if (isRecord(value) && typeof value.toMillis === "function") { const parsed = Number((value.toMillis as () => unknown)()); return Number.isFinite(parsed) ? parsed : null; }
  if (isRecord(value) && typeof value.seconds === "number") return value.seconds * 1_000 + (typeof value.nanoseconds === "number" ? value.nanoseconds / 1_000_000 : 0);
  return null;
};
const reviewStalenessMillis = (record: Record<string, unknown>): number => timestampMillis(record.updatedAt) ?? timestampMillis(record.createdAt) ?? timestampMillis(record.queueCreatedAt) ?? Number.POSITIVE_INFINITY;
const reviewPendingRecord = (record: Record<string, unknown>): boolean => reviewRecordIsRefreshable(record);
const cleanSourceId = (value: unknown): string => { const sourceId = String(value || "").trim(); return sourceId && !sourceId.includes("/") && sourceId.length <= 160 ? sourceId : ""; };
const sourceIdForRecord = (record: Record<string, unknown>): string => cleanSourceId(record.sourceId) || cleanSourceId(record.supplierId);

export async function selectPendingReviewQueueItems(db: Firestore, batchSize: PendingReviewBatchSize): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const snapshot = await db.collection("supplier_review_queue").where("status", "in", ["Pending", "pending"]).get();
  return snapshot.docs.map((document) => ({ id: document.id, data: document.data() as Record<string, unknown> }))
    .filter(({ data }) => reviewPendingRecord(data))
    .sort((left, right) => reviewStalenessMillis(left.data) - reviewStalenessMillis(right.data) || left.id.localeCompare(right.id))
    .slice(0, batchSize);
}

const batchStateFrom = (value: unknown): PendingReviewBatchState | null => {
  if (!isRecord(value)) return null;
  const rawSize = Number(value.batchSize);
  if (!PENDING_REVIEW_BATCH_SIZES.includes(rawSize as PendingReviewBatchSize) || !Array.isArray(value.selectedQueueItemIds)) return null;
  const selectedQueueItemIds = value.selectedQueueItemIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()) && !id.includes("/") && id.length <= 160);
  if (selectedQueueItemIds.length !== value.selectedQueueItemIds.length || selectedQueueItemIds.length > rawSize) return null;
  if (new Set(selectedQueueItemIds).size !== selectedQueueItemIds.length) return null;
  if (new Set(selectedQueueItemIds).size !== selectedQueueItemIds.length) return null;
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes.filter((outcome): outcome is PendingReviewBatchItemOutcome => isRecord(outcome) && typeof outcome.queueItemId === "string" && typeof outcome.outcome === "string").map((outcome) => ({
    queueItemId: outcome.queueItemId,
    outcome: outcome.outcome as PendingReviewBatchOutcome,
    ...(typeof outcome.readyToPublish === "boolean" ? { readyToPublish: outcome.readyToPublish } : {}),
    ...(typeof outcome.unchanged === "boolean" ? { unchanged: outcome.unchanged } : {}),
    ...(typeof outcome.error === "string" ? { error: outcome.error.slice(0, 1_000) } : {}),
    ...(typeof outcome.completedAt === "string" ? { completedAt: outcome.completedAt } : {}),
  })) : [];
  const nextItemIndex = Math.max(0, Math.min(selectedQueueItemIds.length, Math.floor(Number(value.nextItemIndex) || 0)));
  const sourceIds = Array.isArray(value.sourceIds) ? [...new Set(value.sourceIds.filter((id): id is string => typeof id === "string" && Boolean(cleanSourceId(id))).map(cleanSourceId))] : [];
  const inFlightQueueItemId = typeof value.inFlightQueueItemId === "string" && selectedQueueItemIds.includes(value.inFlightQueueItemId) ? value.inFlightQueueItemId : null;
  return { batchSize: rawSize as PendingReviewBatchSize, selectedQueueItemIds: [...selectedQueueItemIds], sourceIds, nextItemIndex, inFlightQueueItemId, inFlightStartedAt: typeof value.inFlightStartedAt === "string" ? value.inFlightStartedAt : null, outcomes };
};
const stateForJob = (job: SupplierSyncJobRecord): PendingReviewBatchState => {
  const state = batchStateFrom(job.pendingReviewBatch);
  if (!state) throw new ApiError("Pending review refresh job state is invalid and cannot be resumed.", 409);
  return state;
};

const metricsFor = (state: PendingReviewBatchState): Pick<PendingReviewBatchRefreshResult, "selected" | "attempted" | "completed" | "refreshedSuccessfully" | "nowReadyToPublish" | "stillBlocked" | "supplierRemovedOrNotFound" | "failed" | "unchanged" | "items"> => {
  const successful = state.outcomes.filter((item) => ["refreshed", "ready_to_publish", "still_blocked", "unchanged"].includes(item.outcome));
  return {
    selected: state.selectedQueueItemIds.length,
    attempted: state.outcomes.length + (state.inFlightQueueItemId ? 1 : 0),
    completed: state.outcomes.length,
    refreshedSuccessfully: successful.length,
    nowReadyToPublish: state.outcomes.filter((item) => item.outcome === "ready_to_publish" || item.readyToPublish === true).length,
    stillBlocked: state.outcomes.filter((item) => item.outcome === "still_blocked" || item.readyToPublish === false).length,
    supplierRemovedOrNotFound: state.outcomes.filter((item) => item.outcome === "supplier_not_found").length,
    failed: state.outcomes.filter((item) => item.outcome === "failed").length,
    unchanged: state.outcomes.filter((item) => item.outcome === "unchanged" || item.unchanged === true).length,
    items: state.outcomes.map((item) => ({ ...item })),
  };
};

export function projectPendingReviewBatchJobForAdmin(job: SupplierSyncJobRecord): PendingReviewBatchRefreshResult & { jobType: typeof PENDING_REVIEW_BATCH_JOB_TYPE; sourceIds: string[]; status: string; nextItemIndex: number; inFlightQueueItemId: string | null } {
  const state = stateForJob(job);
  return {
    jobId: job.id, jobType: PENDING_REVIEW_BATCH_JOB_TYPE, state: String(job.state || "pending"), status: String(job.state || "pending"), sourceIds: [...state.sourceIds], batchSize: state.batchSize,
    ...metricsFor(state), nextItemIndex: state.nextItemIndex, inFlightQueueItemId: state.inFlightQueueItemId, createdAt: job.createdAt, updatedAt: job.updatedAt,
    startedAt: typeof job.startedAt === "string" ? job.startedAt : null, finishedAt: typeof job.finishedAt === "string" ? job.finishedAt : null, lastFailureReason: typeof job.lastFailureReason === "string" ? job.lastFailureReason : null,
  };
}

export async function admitPendingReviewBatch(body: unknown, reviewer: Reviewer, options: { db?: Firestore; now?: number; createJob?: JobCreator } = {}): Promise<{ created: boolean; deduplicated: boolean; job: SupplierSyncJobRecord }> {
  const batchSize = parsePendingReviewBatchSize(body);
  const db = options.db || adminDb;
  const selected = await selectPendingReviewQueueItems(db, batchSize);
  const sourceIds = [...new Set(selected.map(({ data }) => sourceIdForRecord(data)).filter(Boolean))];
  if (selected.length > 0 && sourceIds.length === 0) throw new ApiError("Pending review items do not contain an authoritative supplier source.", 409);
  const pendingReviewBatch: PendingReviewBatchState = { batchSize, selectedQueueItemIds: selected.map(({ id }) => id), sourceIds, nextItemIndex: 0, inFlightQueueItemId: null, inFlightStartedAt: null, outcomes: [] };
  return (options.createJob || createSupplierSyncJob)(db, { trigger: "manual", jobType: PENDING_REVIEW_BATCH_JOB_TYPE, sourceIds, requestedBy: reviewer, pendingReviewBatch: pendingReviewBatch as unknown as Record<string, unknown> }, options.now);
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "").trim().toLocaleLowerCase();
const isSupplierProductNotFound = (error: unknown): boolean => { const message = errorMessage(error); return message.includes("exact dropex reseller catalogue row could not be found") || message.includes("supplier product was not found") || message.includes("supplier product could not be found"); };
const isUnchanged = (item: Record<string, unknown>): boolean => { const comparison = isRecord(item.comparison) ? item.comparison : {}; return String(item.comparisonStatus || comparison.comparisonStatus || "").trim().toUpperCase() === "UNCHANGED"; };
const isReadyToPublish = (item: Record<string, unknown>): boolean => isRecord(item.productValidation) && item.productValidation.readyToPublish === true;
const itemErrorLabel = (error: unknown, notFound: boolean): string => { if (notFound) return "Supplier product was not found in the bounded catalogue lookup."; if (error instanceof ApiError && error.statusCode < 500) return error.publicMessage; return "Supplier review refresh failed; inspect this item and retry individually."; };
const outcomeForSuccess = (item: Record<string, unknown>): PendingReviewBatchItemOutcome["outcome"] => isUnchanged(item) ? "unchanged" : (isReadyToPublish(item) ? "ready_to_publish" : "still_blocked");

const progressForBatch = (state: PendingReviewBatchState, startedAtMs: number, now: number): SupplierSyncJobProgress => {
  const metrics = metricsFor(state); const completed = Math.min(state.selectedQueueItemIds.length, state.nextItemIndex);
  return { modelVersion: 2, determination: "determinate", basis: "limit_upper_bound", phase: completed >= state.selectedQueueItemIds.length ? "completed" : "pending_review_refresh", percent: state.selectedQueueItemIds.length === 0 ? 100 : Math.min(99, Math.round((completed / state.selectedQueueItemIds.length) * 100)), completedSources: 0, totalSources: state.sourceIds.length, currentSourceId: null, pagesProcessed: 0, productsDiscovered: completed, productsObserved: completed, productsScanned: completed, productsQueued: metrics.refreshedSuccessfully, productsFailed: metrics.supplierRemovedOrNotFound + metrics.failed, totalProducts: state.selectedQueueItemIds.length, totalProductsReliability: "exact", elapsedMs: Math.max(0, now - startedAtMs), activeElapsedMs: Math.max(0, now - startedAtMs), etaMs: null, etaAt: null, updatedAt: new Date(now).toISOString() };
};

export interface PendingReviewBatchWorkerContext {
  db?: Firestore;
  workerId: string;
  leaseId: string;
  refreshItem?: SupplierReviewRefresh;
  updateProgress?: typeof updatePendingReviewRefreshJobProgress;
  revalidateItem?: (db: Firestore, queueItemId: string) => Promise<boolean>;
  shouldCancel?: () => boolean;
  now?: () => number;
  maxActiveMs?: number;
}

export async function processPendingReviewRefreshJob(job: SupplierSyncJobRecord, context: PendingReviewBatchWorkerContext): Promise<{ status: "completed" | "waiting" | "cancelled"; state: PendingReviewBatchState; progress: SupplierSyncJobProgress }> {
  const db = context.db || adminDb; const refreshItem = context.refreshItem || refreshActiveSupplierReviewItem; const persist = context.updateProgress || updatePendingReviewRefreshJobProgress; const now = context.now || (() => Date.now()); const state = stateForJob(job); const startedAtMs = timestampMillis(job.startedAt) ?? timestampMillis(job.createdAt) ?? now(); const attemptStartedAtMs = now(); const maxActiveMs = context.maxActiveMs ?? 240_000;
  if (state.inFlightQueueItemId) {
    const recoveredItemId = state.inFlightQueueItemId;
    const recoveredOutcome = state.outcomes.find((item) => item.queueItemId === recoveredItemId);
    if (!recoveredOutcome) {
      state.outcomes = [...state.outcomes, { queueItemId: recoveredItemId, outcome: "failed", error: "The previous worker lease ended before this item completion was committed; inspect the item before retrying it.", completedAt: new Date(now()).toISOString() }];
    }
    state.nextItemIndex = Math.max(state.nextItemIndex, state.selectedQueueItemIds.indexOf(recoveredItemId) + 1); state.inFlightQueueItemId = null; state.inFlightStartedAt = null;
    await persist(db, job.id, context.workerId, context.leaseId, state as unknown as Record<string, unknown>, progressForBatch(state, startedAtMs, now()), now());
  }
  while (state.nextItemIndex < state.selectedQueueItemIds.length) {
    if (context.shouldCancel?.()) return { status: "cancelled", state, progress: progressForBatch(state, startedAtMs, now()) };
    if (state.nextItemIndex > 0 && now() - attemptStartedAtMs >= maxActiveMs) return { status: "waiting", state, progress: progressForBatch(state, startedAtMs, now()) };
    const queueItemId = state.selectedQueueItemIds[state.nextItemIndex];
    const existingOutcome = state.outcomes.find((item) => item.queueItemId === queueItemId);
    if (existingOutcome) {
      state.nextItemIndex += 1;
      await persist(db, job.id, context.workerId, context.leaseId, state as unknown as Record<string, unknown>, progressForBatch(state, startedAtMs, now()), now());
      continue;
    }
    state.inFlightQueueItemId = queueItemId; state.inFlightStartedAt = new Date(now()).toISOString();
    await persist(db, job.id, context.workerId, context.leaseId, state as unknown as Record<string, unknown>, progressForBatch(state, startedAtMs, now()), now());
    let outcome: PendingReviewBatchItemOutcome;
    try {
      const stillRefreshable = context.revalidateItem
        ? await context.revalidateItem(db, queueItemId)
        : await (async () => {
          const snapshot = await db.collection("supplier_review_queue").doc(queueItemId).get();
          return snapshot.exists && reviewRecordIsRefreshable(snapshot.data() as Record<string, unknown>);
        })();
      if (!stillRefreshable) {
        outcome = { queueItemId, outcome: "failed", error: "The pending review item changed before its refresh began and was not refreshed.", completedAt: new Date(now()).toISOString() };
      } else {
        const refreshed = await refreshItem(queueItemId, job.requestedBy); const item = refreshed.item as unknown as Record<string, unknown>; const readyToPublish = isReadyToPublish(item); const unchanged = isUnchanged(item); outcome = { queueItemId, outcome: outcomeForSuccess(item), readyToPublish, unchanged, completedAt: new Date(now()).toISOString() };
      }
    } catch (error: unknown) { const notFound = isSupplierProductNotFound(error); outcome = { queueItemId, outcome: notFound ? "supplier_not_found" : "failed", error: itemErrorLabel(error, notFound), completedAt: new Date(now()).toISOString() }; }
    state.outcomes = [...state.outcomes.filter((item) => item.queueItemId !== queueItemId), outcome]; state.nextItemIndex += 1; state.inFlightQueueItemId = null; state.inFlightStartedAt = null;
    await persist(db, job.id, context.workerId, context.leaseId, state as unknown as Record<string, unknown>, progressForBatch(state, startedAtMs, now()), now());
  }
  return { status: "completed", state, progress: progressForBatch(state, startedAtMs, now()) };
}
