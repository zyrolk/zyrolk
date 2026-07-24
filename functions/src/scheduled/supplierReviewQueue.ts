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
    && requestedUrls.every((url, index) => url === existingUrls[index]);
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
  return String(record.status || "").toLowerCase() === "pending" ? "review_pending" : "queued";
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
): Promise<SupplierQueueProcessResult> {
  const leased = await leaseSupplierReviewQueueItem(db, queueItemId, workerId, now);
  if (!leased) return { queueItemId, outcome: "skipped", state: stateFor({}) };
  try {
    const processingRecord = await markSupplierQueueProcessing(db, queueItemId, workerId, now);
    if (sourceImageUrls(processingRecord).length > 0 || extractSupplierMediaFromRecord(processingRecord.managedMedia).length > 0) {
      await ensureSupplierReviewQueueManagedMedia(db, queueItemId);
    }
    await completeSupplierQueueItem(db, queueItemId, workerId, now);
    return { queueItemId, outcome: "completed", state: "review_pending" };
  } catch (error) {
    const state = await recordSupplierQueueFailure(db, queueItemId, workerId, error, now);
    if (state === "leased" || state === "processing") return { queueItemId, outcome: "skipped", state };
    return { queueItemId, outcome: state === "dead_letter" ? "dead_letter" : "retryable_failure", state };
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
  }
  return recovered;
}

export async function processDueSupplierReviewQueueItems(db: Firestore, workerId: string, now = Date.now(), limit = 50): Promise<SupplierQueueProcessResult[]> {
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
  for (const document of documents) {
    results.push(await processSupplierReviewQueueItem(db, document.id, workerId, now));
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
    transaction.set(reference, {
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
      queueItem: { ...record, queueState: "queued", retryCount: 0 },
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
