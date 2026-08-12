import { FieldValue, Firestore } from "firebase-admin/firestore";
import { createSupplierAuditEvent, SupplierAuditActor } from "../api/suppliers/supplierAuditTrail";
import {
  acquireSupplierManagedMedia,
  applyManagedMediaToProductPayload,
  extractSupplierMediaFromRecord,
  MAX_SUPPLIER_GALLERY_IMAGES,
  SupplierManagedMediaAsset,
  SupplierMediaFailure,
  supplierMediaRetryDelayMs,
} from "../api/suppliers/supplierMediaPipeline";
import {
  buildSupplierQueueIdentityProjection,
  getSupplierQueueIdentityCandidate,
  resolveSupplierQueueIdentity,
} from "../api/suppliers/supplierQueueIdentity";
import { recordSupplierOperationalAlertSafely } from "../api/suppliers/supplierOperationalAlerts";
import { recordSupplierQueueProcessingDurationMetric } from "../api/suppliers/supplierCloudMonitoring";

export const SUPPLIER_QUEUE_STATES = [
  "queued",
  "leased",
  "processing",
  "review_pending",
  "conflict",
  "approved",
  "rejected",
  "retryable_failure",
  "dead_letter",
  "suppressed",
] as const;

export type SupplierQueueState = typeof SUPPLIER_QUEUE_STATES[number];
export type SupplierQueueFailureClassification = "transient" | "permanent" | "validation" | "connector" | "network" | "security";

export interface SupplierQueueProcessResult {
  queueItemId: string;
  outcome: "completed" | "skipped" | "retryable_failure" | "dead_letter";
  state: SupplierQueueState;
}

export interface SupplierQueueProcessingControl {
  currentTime?: () => number;
  verifyWorkerOwnership?: () => void | Promise<void>;
}

export interface SupplierReviewQueueMetrics {
  queueDepth: number;
  retryBacklog: number;
  activeWorkers: number;
  oldestQueueAgeMs: number | null;
  averageProcessingLatencyMs: number | null;
}

interface SupplierQueueRecord extends Record<string, unknown> {
  queueState?: unknown;
  status?: unknown;
  retryCount?: unknown;
  retryLimit?: unknown;
  nextRetryAt?: unknown;
  leaseOwner?: unknown;
  leaseId?: unknown;
  leaseExpiresAt?: unknown;
  importPayload?: unknown;
  pendingChangePayload?: unknown;
  sourceId?: unknown;
  supplierName?: unknown;
  productPayload?: unknown;
  supplierSnapshot?: unknown;
  managedMedia?: unknown;
  mediaFailures?: unknown;
}

const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
  : [];

const sourceImageUrls = (record: SupplierQueueRecord): string[] => {
  const snapshot = asRecord(record.supplierSnapshot);
  const payload = asRecord(record.productPayload);
  const snapshotUrls = stringList(snapshot.mediaGallery).length
    ? stringList(snapshot.mediaGallery)
    : stringList(snapshot.imageUrls);
  const payloadUrls = stringList(payload.imageUrls);
  const primary = asString(payload.imageUrl);
  return [...new Set(snapshotUrls.length ? snapshotUrls : [...payloadUrls, ...(primary ? [primary] : [])])];
};

export interface SupplierQueueManagedMediaResult {
  assets: SupplierManagedMediaAsset[];
  failures: SupplierMediaFailure[];
  reusedExistingQueueMedia: boolean;
}

/**
 * Acquires supplier media before a queue item can enter review. The same helper
 * is reused by approval when an administrator changes image URLs in the draft.
 */
export async function ensureSupplierReviewQueueManagedMedia(
  db: Firestore,
  queueItemId: string,
  options: { imageUrls?: readonly string[]; maxImages?: number } = {},
): Promise<SupplierQueueManagedMediaResult> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  const snapshot = await reference.get();
  if (!snapshot.exists) throw new Error("Supplier review queue item no longer exists.");
  const queueItem = snapshot.data() as SupplierQueueRecord;
  const existingAssets = extractSupplierMediaFromRecord(queueItem.managedMedia);
  const requestedUrls = options.imageUrls === undefined ? undefined : [...options.imageUrls].map((url) => String(url || "").trim()).filter(Boolean);
  const existingUrls = existingAssets.map((asset) => asset.firebaseStorageUrl);
  const requestedExistingMedia = requestedUrls !== undefined
    && requestedUrls.length === existingUrls.length
    && requestedUrls.every((url, index) => (
      url === existingUrls[index]
      || url === existingAssets[index]?.originalSupplierUrl
    ));
  if ((options.imageUrls === undefined || requestedExistingMedia) && existingAssets.length > 0) {
    return {
      assets: existingAssets,
      failures: Array.isArray(queueItem.mediaFailures) ? queueItem.mediaFailures as SupplierMediaFailure[] : [],
      reusedExistingQueueMedia: true,
    };
  }
  const productPayload = asRecord(queueItem.productPayload);
  const supplierSnapshot = asRecord(queueItem.supplierSnapshot);
  const imageUrls = requestedUrls === undefined ? sourceImageUrls(queueItem) : requestedUrls;
  const sourceId = asString(queueItem.sourceId) || asString(supplierSnapshot.sourceId) || "unknown-source";
  const supplierId = asString(supplierSnapshot.supplierId) || sourceId;
  const productId = asString(productPayload.id) || asString(queueItemId);
  const result = await acquireSupplierManagedMedia(db, {
    queueItemId,
    supplierId,
    sourceId,
    productId,
    imageUrls,
    maxImages: Math.min(options.maxImages || MAX_SUPPLIER_GALLERY_IMAGES, MAX_SUPPLIER_GALLERY_IMAGES),
    retryCount: Number(queueItem.retryCount || 0),
  });
  const managedPayload = applyManagedMediaToProductPayload(productPayload, result.assets);
  // Keep supplier URLs in the private review surface so administrators can
  // inspect the upstream source. Approval replaces them with managed URLs.
  const nextPayload = {
    ...productPayload,
    media: managedPayload.media,
    supplierMedia: managedPayload.supplierMedia,
  };
  const pendingChangePayload = asRecord(queueItem.pendingChangePayload);
  const importPayload = asRecord(queueItem.importPayload);
  const validation = asRecord(queueItem.productValidation);
  const existingErrors = Array.isArray(validation.errors) ? validation.errors : [];
  const mediaError = result.assets.length === 0 ? {
    field: "images",
    code: "managed_media_required",
    message: "At least one valid managed product image is required before publishing.",
  } : null;
  const errors = [
    ...existingErrors.filter((entry) => asString(asRecord(entry).code) !== "managed_media_required"),
    ...(mediaError ? [mediaError] : []),
  ];
  const missingFields = [...new Set([
    ...(Array.isArray(validation.missingFields) ? validation.missingFields.map(String) : []),
    ...(mediaError ? ["images"] : []),
  ].filter((field) => !(field === "images" && !mediaError)))];
  const patch: Record<string, unknown> = {
    productPayload: nextPayload,
    managedMedia: result.assets,
    mediaFailures: result.failures,
    mediaStatus: result.assets.length === 0 ? "failed" : result.failures.length > 0 ? "partial" : "ready",
    mediaProcessedAt: new Date().toISOString(),
    mediaDuplicateCount: result.duplicateCount,
    productValidation: {
      ...validation,
      readyToPublish: errors.length === 0,
      missingFields,
      errors,
    },
    supplierSnapshot: {
      ...supplierSnapshot,
      managedMedia: result.assets,
      mediaFailures: result.failures,
    },
    ...(Object.keys(importPayload).length > 0 ? { importPayload: { ...importPayload, managedMedia: result.assets, mediaFailures: result.failures } } : {}),
    ...(Object.keys(pendingChangePayload).length > 0 ? {
      pendingChangePayload: {
        ...pendingChangePayload,
        productPayload: nextPayload,
        managedMedia: result.assets,
        mediaFailures: result.failures,
      },
    } : {}),
  };
  await reference.set(patch, { merge: true });
  return { assets: result.assets, failures: result.failures, reusedExistingQueueMedia: false };
}

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

const retryLimitFor = (record: SupplierQueueRecord): number => {
  const configured = Number(record.retryLimit);
  return Number.isInteger(configured) && configured > 0 && configured <= 20 ? configured : DEFAULT_RETRY_LIMIT;
};

const retryCountFor = (record: SupplierQueueRecord): number => {
  const count = Number(record.retryCount);
  return Number.isInteger(count) && count >= 0 ? count : 0;
};

const stateFor = (record: SupplierQueueRecord): SupplierQueueState => {
  const state = asString(record.queueState) as SupplierQueueState;
  if ((SUPPLIER_QUEUE_STATES as readonly string[]).includes(state)) return state;
  // Existing review records were created before lifecycle metadata existed.
  const legacyStatus = String(record.status || "").toLowerCase();
  if (legacyStatus === "pending") return "review_pending";
  if (legacyStatus === "conflict") return "conflict";
  if (legacyStatus === "approved") return "approved";
  if (legacyStatus === "rejected") return "rejected";
  return "queued";
};

const nextRetryAt = (attempt: number, now: number): string => new Date(now + supplierMediaRetryDelayMs(attempt)).toISOString();

export function buildSupplierQueueLifecycle(createdAt = new Date().toISOString()): Record<string, unknown> {
  return {
    queueState: "queued" satisfies SupplierQueueState,
    retryCount: 0,
    retryLimit: DEFAULT_RETRY_LIMIT,
    nextRetryAt: createdAt,
    queueCreatedAt: createdAt,
  };
}

export function classifySupplierQueueFailure(error: unknown): SupplierQueueFailureClassification {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  if (name.includes("supplierurlvalidation") || /blocked|allowlist|ssrf|security/.test(message)) return "security";
  if (/validation|invalid supplier product|category is required|product payload/.test(message)) return "validation";
  if (/abort|timeout|econn|enotfound|dns|socket|network/.test(message)) return "network";
  if (/connector|supplier api|a2z|authentication/.test(message)) return "connector";
  if (/permission|forbidden|unauthorized|not found|unsupported/.test(message)) return "permanent";
  return "transient";
}

export function isSupplierQueueLeaseExpired(record: SupplierQueueRecord, now = Date.now()): boolean {
  const expiresAt = toMillis(record.leaseExpiresAt);
  return expiresAt > 0 && expiresAt <= now;
}

export function canLeaseSupplierQueueItem(record: SupplierQueueRecord, now = Date.now()): boolean {
  const state = stateFor(record);
  if (state === "queued") return toMillis(record.nextRetryAt) <= now;
  if (state === "retryable_failure") return toMillis(record.nextRetryAt) <= now;
  return (state === "leased" || state === "processing") && isSupplierQueueLeaseExpired(record, now);
}

export function buildSupplierQueueFailureUpdate(
  record: SupplierQueueRecord,
  error: unknown,
  now: number,
  options: { recoveredLease?: boolean } = {},
): { state: SupplierQueueState; data: Record<string, unknown> } {
  const retryCount = retryCountFor(record) + 1;
  const retryLimit = retryLimitFor(record);
  const classification = options.recoveredLease ? "transient" : classifySupplierQueueFailure(error);
  const reason = options.recoveredLease ? "Worker lease expired before processing completed." : (error instanceof Error ? error.message : String(error || "Queue processing failed."));
  const terminal = classification === "security" || classification === "validation" || classification === "permanent" || retryCount >= retryLimit;
  const state: SupplierQueueState = terminal ? "dead_letter" : "retryable_failure";
  return {
    state,
    data: {
      queueState: state,
      retryCount,
      retryLimit,
      nextRetryAt: terminal ? FieldValue.delete() : nextRetryAt(retryCount, now),
      lastFailureAt: new Date(now).toISOString(),
      lastFailureReason: reason.slice(0, 1_000),
      failureClassification: classification,
      ...(!terminal ? { lastRetryScheduledAt: new Date(now).toISOString() } : {}),
      ...(terminal ? { deadLetteredAt: new Date(now).toISOString() } : {}),
      leaseOwner: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    },
  };
};

export async function leaseSupplierReviewQueueItem(
  db: Firestore,
  queueItemId: string,
  workerId: string,
  now = Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
): Promise<SupplierQueueRecord | null> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const record = snapshot.data() as SupplierQueueRecord;
    const currentState = stateFor(record);
    if ((currentState === "leased" || currentState === "processing") && isSupplierQueueLeaseExpired(record, now)) {
      const failure = buildSupplierQueueFailureUpdate(record, new Error("Worker lease expired."), now, { recoveredLease: true });
      transaction.set(reference, failure.data, { merge: true });
      createSupplierAuditEvent(db, transaction, {
        queueItemId,
        queueItem: { ...record, ...failure.data },
        action: failure.state === "dead_letter" ? "dead_letter" : "retryable_failure",
        previousState: currentState,
        newState: failure.state,
        workerId: "recovery",
        reason: "Worker lease expired before processing completed.",
        now,
      });
      return null;
    }
    if (!canLeaseSupplierQueueItem(record, now)) return null;
    const leaseId = `${workerId}:${Number(record.leaseCount || 0) + 1}:${now}`;
    transaction.set(reference, {
      queueState: "leased" satisfies SupplierQueueState,
      leaseOwner: workerId,
      leaseId,
      leaseAcquiredAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      lastLeasedAt: new Date(now).toISOString(),
      leaseCount: Number(record.leaseCount || 0) + 1,
    }, { merge: true });
    createSupplierAuditEvent(db, transaction, {
      queueItemId,
      queueItem: { ...record, leaseId },
      action: "leased",
      previousState: currentState,
      newState: "leased",
      workerId,
      leaseId,
      now,
    });
    return record;
  });
}

export async function heartbeatSupplierReviewQueueLease(
  db: Firestore,
  queueItemId: string,
  workerId: string,
  leaseId: string,
  now = Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const record = snapshot.exists ? snapshot.data() as SupplierQueueRecord : null;
    const state = record ? stateFor(record) : null;
    if (
      !record
      || (state !== "leased" && state !== "processing")
      || asString(record.leaseOwner) !== workerId
      || asString(record.leaseId) !== leaseId
      || isSupplierQueueLeaseExpired(record, now)
    ) return false;
    transaction.set(reference, {
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      leaseHeartbeatAt: new Date(now).toISOString(),
      leaseHeartbeatCount: Number(record.leaseHeartbeatCount || 0) + 1,
    }, { merge: true });
    return true;
  });
}

async function markSupplierQueueProcessing(db: Firestore, queueItemId: string, workerId: string, now: number): Promise<SupplierQueueRecord> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const record = snapshot.exists ? snapshot.data() as SupplierQueueRecord : null;
    if (!record || stateFor(record) !== "leased" || asString(record.leaseOwner) !== workerId || isSupplierQueueLeaseExpired(record, now)) {
      throw new Error("Supplier queue lease is no longer owned by this worker.");
    }
    transaction.set(reference, {
      queueState: "processing" satisfies SupplierQueueState,
      processingStartedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + DEFAULT_LEASE_MS).toISOString(),
      leaseHeartbeatAt: new Date(now).toISOString(),
    }, { merge: true });
    createSupplierAuditEvent(db, transaction, {
      queueItemId,
      queueItem: record,
      action: "processing",
      previousState: "leased",
      newState: "processing",
      workerId,
      leaseId: asString(record.leaseId),
      now,
    });
    return record;
  });
}

async function completeSupplierQueueItem(db: Firestore, queueItemId: string, workerId: string, now: number): Promise<void> {
  const reviewReference = db.collection("supplier_review_queue").doc(queueItemId);
  const importReference = db.collection("supplier_import_queue").doc(queueItemId);
  const pendingReference = db.collection("supplier_pending_changes").doc(`change-${queueItemId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reviewReference);
    const record = snapshot.exists ? snapshot.data() as SupplierQueueRecord : null;
    if (!record || stateFor(record) !== "processing" || asString(record.leaseOwner) !== workerId || isSupplierQueueLeaseExpired(record, now)) {
      throw new Error("Supplier queue lease is no longer owned by this worker.");
    }
    const importPayload = asRecord(record.importPayload);
    if (Object.keys(importPayload).length > 0) transaction.set(importReference, importPayload, { merge: true });
    const pendingChangePayload = asRecord(record.pendingChangePayload);
    if (Object.keys(pendingChangePayload).length > 0) transaction.set(pendingReference, pendingChangePayload, { merge: true });
    transaction.set(reviewReference, {
      queueState: "review_pending" satisfies SupplierQueueState,
      status: "Pending",
      completedAt: new Date(now).toISOString(),
      completedBy: workerId,
      leaseOwner: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
      importPayload: FieldValue.delete(),
      pendingChangePayload: FieldValue.delete(),
    }, { merge: true });
    createSupplierAuditEvent(db, transaction, {
      queueItemId,
      queueItem: record,
      action: "review_pending",
      previousState: "processing",
      newState: "review_pending",
      workerId,
      leaseId: asString(record.leaseId),
      now,
    });
  });
}

async function recordSupplierQueueFailure(
  db: Firestore,
  queueItemId: string,
  workerId: string,
  error: unknown,
  now: number,
  recoveredLease = false,
): Promise<SupplierQueueState> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const record = snapshot.exists ? snapshot.data() as SupplierQueueRecord : null;
    if (!record) return "dead_letter";
    const state = stateFor(record);
    if (recoveredLease && (
      (state !== "leased" && state !== "processing")
      || !isSupplierQueueLeaseExpired(record, now)
    )) return state;
    if (!recoveredLease && (!((state === "leased") || (state === "processing")) || asString(record.leaseOwner) !== workerId || isSupplierQueueLeaseExpired(record, now))) {
      return state;
    }
    const failure = buildSupplierQueueFailureUpdate(record, error, now, { recoveredLease });
    transaction.set(reference, failure.data, { merge: true });
    createSupplierAuditEvent(db, transaction, {
      queueItemId,
      queueItem: { ...record, ...failure.data },
      action: failure.state === "dead_letter" ? "dead_letter" : "retryable_failure",
      previousState: state,
      newState: failure.state,
      workerId,
      leaseId: asString(record.leaseId),
      reason: String(failure.data.lastFailureReason || "Queue processing failed."),
      now,
    });
    return failure.state;
  });
}

export async function processSupplierReviewQueueItem(
  db: Firestore,
  queueItemId: string,
  workerId: string,
  now = Date.now(),
  control: SupplierQueueProcessingControl = {},
): Promise<SupplierQueueProcessResult> {
  await control.verifyWorkerOwnership?.();
  const leased = await leaseSupplierReviewQueueItem(db, queueItemId, workerId, now);
  if (!leased) return { queueItemId, outcome: "skipped", state: stateFor({}) };
  const wallClockStartedAt = Date.now();
  const currentTime = control.currentTime
    || (() => now + Math.max(0, Date.now() - wallClockStartedAt));
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight: Promise<void> = Promise.resolve();
  let leaseLost = false;
  try {
    await control.verifyWorkerOwnership?.();
    const processingRecord = await markSupplierQueueProcessing(db, queueItemId, workerId, now);
    const leaseId = asString(processingRecord.leaseId);
    const sendHeartbeat = (): void => {
      if (leaseLost) return;
      heartbeatInFlight = heartbeatInFlight.then(async () => {
        const renewed = await heartbeatSupplierReviewQueueLease(db, queueItemId, workerId, leaseId, currentTime());
        if (!renewed) leaseLost = true;
      }).catch(() => { leaseLost = true; });
    };
    heartbeatTimer = setInterval(sendHeartbeat, LEASE_HEARTBEAT_INTERVAL_MS);
    await control.verifyWorkerOwnership?.();
    if (sourceImageUrls(processingRecord).length > 0 || extractSupplierMediaFromRecord(processingRecord.managedMedia).length > 0) {
      await ensureSupplierReviewQueueManagedMedia(db, queueItemId);
    }
    await control.verifyWorkerOwnership?.();
    sendHeartbeat();
    await heartbeatInFlight;
    if (leaseLost) throw new Error("Supplier queue lease was lost during processing.");
    await control.verifyWorkerOwnership?.();
    await completeSupplierQueueItem(db, queueItemId, workerId, currentTime());
    return { queueItemId, outcome: "completed", state: "review_pending" };
  } catch (error) {
    const state = await recordSupplierQueueFailure(db, queueItemId, workerId, error, currentTime());
    const supplierId = asString(leased.supplierId) || asString(asRecord(leased.supplierSnapshot).supplierId) || asString(leased.sourceId) || null;
    if (state === "dead_letter") {
      await recordSupplierOperationalAlertSafely({
        category: "dead_letter_created",
        severity: "critical",
        supplierId,
        queueItemId,
        jobId: asString(leased.jobId) || null,
        batchId: asString(leased.batchId) || null,
        technicalMetadata: {
          workerId,
          failureClassification: classifySupplierQueueFailure(error),
          reason: error instanceof Error ? error.message : String(error || "Queue processing failed."),
        },
      });
    }
    if (error instanceof Error && error.name === "SupplierMediaRetryableError") {
      const metadata = {
        workerId,
        reason: error.message,
        retryCount: retryCountFor(leased),
      };
      await recordSupplierOperationalAlertSafely({
        category: "media_processing_failure",
        severity: "critical",
        supplierId,
        queueItemId,
        batchId: asString(leased.batchId) || null,
        technicalMetadata: metadata,
      });
      if (/firebase storage|storage|upload failed|bucket/iu.test(error.message)) {
        await recordSupplierOperationalAlertSafely({
          category: "storage_failure",
          severity: "critical",
          supplierId,
          queueItemId,
          batchId: asString(leased.batchId) || null,
          technicalMetadata: metadata,
        });
      }
    }
    if (state === "leased" || state === "processing") return { queueItemId, outcome: "skipped", state };
    return { queueItemId, outcome: state === "dead_letter" ? "dead_letter" : "retryable_failure", state };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatInFlight;
  }
}

export async function recoverExpiredSupplierReviewQueueLeases(db: Firestore, now = Date.now(), limit = 100): Promise<number> {
  const nowIso = new Date(now).toISOString();
  const snapshots = await Promise.all(["leased", "processing"].map((queueState) => db.collection("supplier_review_queue")
    .where("queueState", "==", queueState)
    .where("leaseExpiresAt", "<=", nowIso)
    .orderBy("leaseExpiresAt", "asc")
    .orderBy("queueCreatedAt", "asc")
    .limit(limit)
    .get()));
  const documents = [...new Map(snapshots.flatMap((snapshot) => snapshot.docs).map((document) => [document.id, document])).values()]
    .sort((left, right) => String(left.data().leaseExpiresAt || "").localeCompare(String(right.data().leaseExpiresAt || "")))
    .slice(0, limit);
  let recovered = 0;
  for (const document of documents) {
    if (!isSupplierQueueLeaseExpired(document.data() as SupplierQueueRecord, now)) continue;
    const state = await recordSupplierQueueFailure(db, document.id, "recovery", new Error("Worker lease expired."), now, true);
    if (state === "retryable_failure" || state === "dead_letter") recovered += 1;
    if (state === "dead_letter") {
      const item = document.data() as SupplierQueueRecord;
      await recordSupplierOperationalAlertSafely({
        category: "dead_letter_created",
        severity: "critical",
        supplierId: asString(item.supplierId) || asString(asRecord(item.supplierSnapshot).supplierId) || asString(item.sourceId) || null,
        queueItemId: document.id,
        jobId: asString(item.jobId) || null,
        batchId: asString(item.batchId) || null,
        technicalMetadata: { reason: "Worker lease expired before processing completed.", recoveredBy: "recovery" },
      });
    }
  }
  return recovered;
}

export async function processDueSupplierReviewQueueItems(
  db: Firestore,
  workerId: string,
  now = Date.now(),
  limit = 50,
  control: SupplierQueueProcessingControl = {},
): Promise<SupplierQueueProcessResult[]> {
  const nowIso = new Date(now).toISOString();
  const perStateLimit = Math.max(1, Math.ceil(limit / 2));
  const snapshots = await Promise.all(["queued", "retryable_failure"].map((queueState) => db.collection("supplier_review_queue")
    .where("queueState", "==", queueState)
    .where("nextRetryAt", "<=", nowIso)
    .orderBy("nextRetryAt", "asc")
    .orderBy("queueCreatedAt", "asc")
    .limit(perStateLimit)
    .get()));
  const documents = [...new Map(snapshots.flatMap((snapshot) => snapshot.docs).map((document) => [document.id, document])).values()]
    .sort((left, right) => {
      const nextRetryOrder = String(left.data().nextRetryAt || "").localeCompare(String(right.data().nextRetryAt || ""));
      return nextRetryOrder || String(left.data().queueCreatedAt || "").localeCompare(String(right.data().queueCreatedAt || ""));
    })
    .slice(0, limit);
  const results: SupplierQueueProcessResult[] = [];
  const currentTime = control.currentTime || Date.now;
  for (const document of documents) {
    await control.verifyWorkerOwnership?.();
    const itemStartedAt = currentTime();
    const result = await processSupplierReviewQueueItem(db, document.id, workerId, itemStartedAt, {
      ...control,
      currentTime,
    });
    results.push(result);
    if (result.outcome !== "skipped") {
      recordSupplierQueueProcessingDurationMetric({
        durationMs: Math.max(0, currentTime() - itemStartedAt),
        outcome: result.outcome,
        queueItemId: result.queueItemId,
      });
    }
    await control.verifyWorkerOwnership?.();
  }
  return results;
}

/**
 * Uses Firestore aggregation queries and bounded ordered reads so operational
 * dashboards do not turn queue metrics into collection scans.
 */
export async function getSupplierReviewQueueMetrics(db: Firestore, now = Date.now()): Promise<SupplierReviewQueueMetrics> {
  const queue = db.collection("supplier_review_queue");
  const [total, retryable, leased, processing, oldestQueued, oldestRetryable, completedAudit] = await Promise.all([
    queue.count().get(),
    queue.where("queueState", "==", "retryable_failure").count().get(),
    queue.where("queueState", "==", "leased").count().get(),
    queue.where("queueState", "==", "processing").count().get(),
    queue.where("queueState", "==", "queued").orderBy("queueCreatedAt", "asc").limit(1).get(),
    queue.where("queueState", "==", "retryable_failure").orderBy("queueCreatedAt", "asc").limit(1).get(),
    db.collection("supplier_approval_audit").where("action", "==", "review_pending").orderBy("timestamp", "desc").limit(100).get(),
  ]);
  const oldest = [...oldestQueued.docs, ...oldestRetryable.docs]
    .map((document) => toMillis((document.data() as SupplierQueueRecord).queueCreatedAt))
    .filter((timestamp) => timestamp > 0)
    .sort((left, right) => left - right)[0];
  const durations = completedAudit.docs
    .map((document) => Number(document.data().processingDurationMs))
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  return {
    queueDepth: total.data().count,
    retryBacklog: retryable.data().count,
    activeWorkers: leased.data().count + processing.data().count,
    oldestQueueAgeMs: oldest ? Math.max(0, now - oldest) : null,
    averageProcessingLatencyMs: durations.length
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : null,
  };
}

export type SupplierQueuePageView = "review" | "import" | "changes";
export type SupplierReviewQueuePageState = "active" | "review_pending" | "conflict" | "approved" | "rejected" | "history";
export type SupplierReviewBusinessFilter =
  | "new_products"
  | "product_updates"
  | "removed_products"
  | "conflicts"
  | "needs_attention"
  | "approved_history";

export interface SupplierQueuePageResult {
  view: SupplierQueuePageView;
  state: string;
  items: Array<Record<string, unknown> & { id: string }>;
  nextCursor: string | null;
}

const reviewStatusValues = (state: SupplierReviewQueuePageState): string[] => {
  if (state === "conflict") return ["CONFLICT"];
  if (state === "approved") return ["Approved"];
  if (state === "rejected") return ["Rejected"];
  if (state === "history") return ["Approved", "Rejected"];
  if (state === "review_pending") return ["Pending"];
  return ["Pending", "CONFLICT"];
};

const reviewRecordMatchesState = (record: SupplierQueueRecord, state: SupplierReviewQueuePageState): boolean => {
  const queueState = stateFor(record);
  if (state === "history") return ["approved", "rejected", "suppressed"].includes(queueState);
  if (state === "active") {
    return [
      "queued",
      "leased",
      "processing",
      "review_pending",
      "conflict",
      "retryable_failure",
      "dead_letter",
    ].includes(queueState);
  }
  return queueState === state;
};

const normalizedReviewValue = (value: unknown): string => String(value || "").trim().toLowerCase();

const reviewRecordIsConflict = (record: SupplierQueueRecord): boolean => (
  normalizedReviewValue(record.status) === "conflict" || normalizedReviewValue(record.queueState) === "conflict"
);

const reviewRecordIsApproved = (record: SupplierQueueRecord): boolean => (
  normalizedReviewValue(record.status) === "approved" || normalizedReviewValue(record.queueState) === "approved"
);

const reviewRecordIsTerminalDecision = (record: SupplierQueueRecord): boolean => (
  reviewRecordIsApproved(record)
  || normalizedReviewValue(record.status) === "rejected"
  || ["rejected", "suppressed"].includes(normalizedReviewValue(record.queueState))
);

const reviewComparisonIsRemoval = (value: unknown): boolean => {
  const comparisonStatus = normalizedReviewValue(value);
  return comparisonStatus.includes("removed")
    || comparisonStatus.includes("deleted")
    || comparisonStatus.includes("deactivat");
};

/** Mirrors the Product Review business filters on the server pagination boundary. */
export const reviewRecordMatchesBusinessFilter = (
  record: SupplierQueueRecord,
  filter: SupplierReviewBusinessFilter,
): boolean => {
  const comparisonStatus = normalizedReviewValue(asRecord(record.comparison).comparisonStatus);
  if (filter === "approved_history") return reviewRecordIsTerminalDecision(record);
  if (filter === "conflicts") return reviewRecordIsConflict(record);
  if (filter === "removed_products") return reviewComparisonIsRemoval(comparisonStatus);
  if (filter === "new_products") return comparisonStatus === "new_product";
  if (filter === "needs_attention") {
    const validation = asRecord(record.productValidation);
    return validation.readyToPublish === false
      || (Array.isArray(validation.missingFields) && validation.missingFields.length > 0)
      || (Array.isArray(validation.errors) && validation.errors.length > 0)
      || ["failed", "partial"].includes(normalizedReviewValue(record.mediaStatus))
      || ["retryable_failure", "dead_letter"].includes(normalizedReviewValue(record.queueState));
  }
  return !reviewRecordIsApproved(record)
    && !reviewRecordIsConflict(record)
    && comparisonStatus !== "new_product"
    && !reviewComparisonIsRemoval(comparisonStatus);
};

/**
 * Bounded, server-authoritative pagination for the three Supplier Hub queue
 * views. Review status filtering is index-backed; client collection listeners
 * are deliberately not part of this path.
 */
export async function listSupplierQueuePage(
  db: Firestore,
  options: {
    view: SupplierQueuePageView;
    state?: SupplierReviewQueuePageState;
    businessFilter?: SupplierReviewBusinessFilter;
    after?: string;
    limit?: number;
  },
): Promise<SupplierQueuePageResult> {
  const pageLimit = Number.isInteger(options.limit) ? Math.max(1, Math.min(100, Number(options.limit))) : 50;
  const state = options.view === "review" ? options.state || "active" : "active";
  const collectionName = options.view === "review"
    ? "supplier_review_queue"
    : options.view === "import" ? "supplier_import_queue" : "supplier_pending_changes";
  const collection = db.collection(collectionName);
  const scanLimit = options.view === "review" ? Math.min(300, pageLimit * 3) : pageLimit;
  let query: FirebaseFirestore.Query = collection;
  if (options.view === "review") {
    const statuses = reviewStatusValues(state as SupplierReviewQueuePageState);
    query = statuses.length === 1
      ? query.where("status", "==", statuses[0])
      : query.where("status", "in", statuses);
  }
  query = query.orderBy("createdAt", "desc");
  if (options.after) {
    const cursor = await collection.doc(options.after).get();
    if (!cursor.exists) throw new Error("Supplier queue cursor is invalid.");
    query = query.startAfter(cursor);
  }

  if (options.view === "review" && options.businessFilter) {
    const documents: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    const batchLimit = Math.min(100, Math.max(50, pageLimit));
    let nextQuery = query;
    let nextCursor: string | null = null;

    while (documents.length < pageLimit) {
      const snapshot = await nextQuery.limit(batchLimit).get();
      if (snapshot.empty) {
        nextCursor = null;
        break;
      }

      let pageFilledAt = -1;
      for (let index = 0; index < snapshot.docs.length; index += 1) {
        const document = snapshot.docs[index];
        const record = document.data() as SupplierQueueRecord;
        if (reviewRecordMatchesState(record, state as SupplierReviewQueuePageState)
          && reviewRecordMatchesBusinessFilter(record, options.businessFilter)) {
          documents.push(document);
          if (documents.length === pageLimit) {
            pageFilledAt = index;
            break;
          }
        }
      }

      const lastScannedDocument = pageFilledAt >= 0
        ? snapshot.docs[pageFilledAt]
        : snapshot.docs.at(-1);
      const collectionEnded = snapshot.size < batchLimit;
      if (pageFilledAt >= 0) {
        nextCursor = collectionEnded && pageFilledAt === snapshot.docs.length - 1
          ? null
          : lastScannedDocument?.id || null;
        break;
      }
      if (collectionEnded || !lastScannedDocument) {
        nextCursor = null;
        break;
      }
      nextQuery = query.startAfter(lastScannedDocument);
    }

    return {
      view: options.view,
      state,
      items: documents.map((document) => ({ id: document.id, ...document.data() })),
      nextCursor,
    };
  }

  const snapshot = await query.limit(scanLimit).get();
  const matched = snapshot.docs.filter((document) => options.view !== "review"
    || reviewRecordMatchesState(document.data() as SupplierQueueRecord, state as SupplierReviewQueuePageState));
  const pageDocuments = matched.slice(0, pageLimit);
  const cursorDocument = pageDocuments.length === pageLimit
    ? pageDocuments.at(-1)
    : snapshot.size === scanLimit ? snapshot.docs.at(-1) : null;
  return {
    view: options.view,
    state,
    items: pageDocuments.map((document) => ({ id: document.id, ...document.data() })),
    nextCursor: cursorDocument?.id || null,
  };
}

export async function retryDeadLetterSupplierReviewQueueItem(
  db: Firestore,
  queueItemId: string,
  now = Date.now(),
  admin?: SupplierAuditActor,
): Promise<boolean> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const record = snapshot.exists ? snapshot.data() as SupplierQueueRecord : null;
    if (!record || !["dead_letter", "suppressed"].includes(stateFor(record))) return false;
    const queueIdentityCandidate = getSupplierQueueIdentityCandidate(record);
    const queueIdentityProjection = queueIdentityCandidate.claimedProductId
      || queueIdentityCandidate.claimedOfferId
      ? buildSupplierQueueIdentityProjection(
        record,
        await resolveSupplierQueueIdentity(db, transaction, record),
      )
      : {};
    transaction.set(reference, {
      ...queueIdentityProjection,
      queueState: "queued" satisfies SupplierQueueState,
      status: "Pending",
      retryCount: 0,
      nextRetryAt: new Date(now).toISOString(),
      recoveredAt: new Date(now).toISOString(),
      manualRetryCount: Number(record.manualRetryCount || 0) + 1,
      deadLetteredAt: FieldValue.delete(),
      leaseOwner: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    }, { merge: true });
    createSupplierAuditEvent(db, transaction, {
      queueItemId,
      queueItem: { ...record, ...queueIdentityProjection, queueState: "queued", retryCount: 0 },
      action: "retry",
      previousState: stateFor(record),
      newState: "queued",
      admin,
      reason: "Administrator retried a dead-letter supplier review item.",
      now,
    });
    return true;
  });
}
