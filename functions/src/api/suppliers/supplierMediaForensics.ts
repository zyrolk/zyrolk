import { Firestore } from "firebase-admin/firestore";
import {
  extractSupplierMediaFromRecord,
  SUPPLIER_MEDIA_COLLECTION,
  SUPPLIER_MEDIA_AUDIT_COLLECTION,
} from "./supplierMediaPipeline";
import { classifySupplierMediaObservability } from "./supplierMediaObservability";
import {
  explainSupplierQueueEligibility,
  SupplierQueueRecord,
} from "../../scheduled/supplierReviewQueue";

type NullableNumber = number | null;

export interface SupplierMediaForensicEvidence {
  supplier: string | null;
  supplierSku: string | null;
  supplierProductId: string | null;
  reviewId: string;
  queue: {
    state: string | null;
    eligibleNow: boolean | null;
    eligibilityReasons: string[];
    createdAt: string | null;
    updatedAt: string | null;
  };
  lease: {
    active: boolean | null;
    leaseId: string | null;
    acquiredAt: string | null;
    expiresAt: string | null;
    expired: boolean | null;
  };
  retry: {
    retryCount: NullableNumber;
    retryLimit: NullableNumber;
    nextRetryAt: string | null;
    retryable: boolean | null;
    exhausted: boolean | null;
  };
  worker: {
    lastAttemptAt: string | null;
    lastAttemptResult: string | null;
    attemptCount: NullableNumber;
    health: {
      schedule: string;
      status: string | null;
      lastObservedExecution: string | null;
      lastSuccess: string | null;
      lastFailure: string | null;
      attempted: NullableNumber;
      completed: NullableNumber;
      leaseRecoveries: NullableNumber;
    };
  };
  media: {
    sourceImageCount: NullableNumber;
    managedImageCount: NullableNumber;
    usablePrimaryImage: boolean | null;
    readiness: "ready" | "blocked" | "unknown";
    lastActivityAt: string | null;
    safeFailureClass: string;
  };
  finalization: {
    assetPersisted: boolean | null;
    readinessProjected: boolean | null;
    reviewStateUpdated: boolean | null;
    auditEvents: string[];
  };
  diagnosis: {
    possiblyStuck: boolean;
    blockingPredicate: string | null;
    nextExpectedTransition: string | null;
  };
}

interface FirestoreRecord extends Record<string, unknown> {}

const asRecord = (value: unknown): FirestoreRecord => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as FirestoreRecord
    : {}
);

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const timestampMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (value && typeof value === "object") {
    const candidate = value as { toMillis?: unknown; seconds?: unknown; _seconds?: unknown };
    if (typeof candidate.toMillis === "function") {
      const parsed = Number(candidate.toMillis());
      return Number.isFinite(parsed) ? parsed : null;
    }
    const seconds = Number(candidate.seconds ?? candidate._seconds);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  return null;
};

const isoOrNull = (value: unknown): string | null => {
  const milliseconds = timestampMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
};

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    const result = asString(value);
    if (result) return result;
  }
  return null;
};

const firstNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const result = numberOrNull(value);
    if (result !== null) return result;
  }
  return null;
};

const hasOwn = (record: FirestoreRecord, field: string): boolean => (
  Object.prototype.hasOwnProperty.call(record, field)
);

const lastTimestamp = (record: FirestoreRecord, fields: string[]): string | null => {
  const values = fields
    .map((field) => timestampMs(record[field]))
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : new Date(Math.max(...values)).toISOString();
};

const safeAuditEventNames = (records: FirebaseFirestore.QueryDocumentSnapshot[]): string[] => (
  [...new Set(records
    .map((record) => asString(record.data().event))
    .filter(Boolean))]
);

const readMediaAuditEvents = async (db: Firestore, queueItemId: string): Promise<{
  names: string[];
  latestAt: string | null;
}> => {
  try {
    const snapshot = await db.collection(SUPPLIER_MEDIA_AUDIT_COLLECTION)
      .where("queueItemId", "==", queueItemId)
      .limit(50)
      .get();
    const latest = snapshot.docs
      .map((document) => timestampMs(document.data().timestamp))
      .filter((value): value is number => value !== null)
      .sort((left, right) => right - left)[0];
    return {
      names: safeAuditEventNames(snapshot.docs),
      latestAt: latest === undefined ? null : new Date(latest).toISOString(),
    };
  } catch {
    return { names: [], latestAt: null };
  }
};

const readPersistedAssets = async (
  db: Firestore,
  record: SupplierQueueRecord,
  productId: string | null,
): Promise<boolean | null> => {
  const managedMedia = extractSupplierMediaFromRecord(record.managedMedia);
  if (managedMedia.length > 0) return true;
  if (!productId) return null;
  try {
    const snapshot = await db.collection(SUPPLIER_MEDIA_COLLECTION)
      .where("productId", "==", productId)
      .limit(25)
      .get();
    return snapshot.size > 0;
  } catch {
    return null;
  }
};

const readWorkerHealth = async (db: Firestore): Promise<SupplierMediaForensicEvidence["worker"]["health"]> => {
  try {
    const snapshot = await db.collection("supplier_settings").doc("config").get();
    const settings = snapshot.exists ? asRecord(snapshot.data()) : {};
    const lastRun = asRecord(settings.queueWorkerLastRun);
    return {
      schedule: "every 5 minutes",
      status: firstString(settings.queueWorkerStatus),
      lastObservedExecution: firstString(settings.queueWorkerLastRunAt, settings.queueWorkerLastFailureAt),
      lastSuccess: firstString(settings.queueWorkerLastRunAt),
      lastFailure: firstString(settings.queueWorkerLastFailureAt),
      attempted: firstNumber(lastRun.processed),
      completed: firstNumber(lastRun.completed),
      leaseRecoveries: firstNumber(lastRun.recoveredLeases),
    };
  } catch {
    return {
      schedule: "every 5 minutes",
      status: null,
      lastObservedExecution: null,
      lastSuccess: null,
      lastFailure: null,
      attempted: null,
      completed: null,
      leaseRecoveries: null,
    };
  }
};

export const projectSupplierMediaForensicEvidence = async (
  db: Firestore,
  reviewId: string,
  record: SupplierQueueRecord,
  now = Date.now(),
): Promise<SupplierMediaForensicEvidence> => {
  const payload = asRecord(record.productPayload);
  const snapshot = asRecord(record.supplierSnapshot);
  const observation = classifySupplierMediaObservability(record, now);
  const eligibility = explainSupplierQueueEligibility(record, now);
  const queueState = asString(record.queueState) || null;
  const leaseExpiryMs = timestampMs(record.leaseExpiresAt);
  const leaseId = firstString(record.leaseId);
  const productId = firstString(
    record.supplierProductId,
    record.productId,
    payload.supplierProductId,
    payload.productId,
    snapshot.supplierProductId,
    snapshot.productId,
  );
  const supplierSku = firstString(
    record.supplierItemCode,
    record.supplierSku,
    payload.supplierItemCode,
    payload.supplierSku,
    payload.sku,
    snapshot.supplierItemCode,
    snapshot.supplierSku,
    snapshot.sku,
  );
  const audit = await readMediaAuditEvents(db, reviewId);
  const [assetPersisted, workerHealth] = await Promise.all([
    readPersistedAssets(db, record, productId),
    readWorkerHealth(db),
  ]);
  const finalizationReadiness = hasOwn(record, "mediaReadiness")
    || hasOwn(record, "mediaStatus")
    || hasOwn(record, "mediaProcessedAt")
    ? true
    : null;
  const reviewStateUpdated = queueState === null
    ? null
    : queueState === "review_pending" || audit.names.includes("review_pending");
  const lastAttemptAt = lastTimestamp(record, [
    "lastLeasedAt",
    "leaseAcquiredAt",
    "processingStartedAt",
    "lastFailureAt",
    "mediaProcessedAt",
  ]);
  const lastAttemptResult = firstString(
    record.lastAttemptResult,
    queueState === "review_pending" ? "completed" : null,
    queueState === "retryable_failure" ? "retryable_failure" : null,
    queueState === "dead_letter" ? "dead_letter" : null,
    queueState === "processing" || queueState === "leased" ? "in_progress" : null,
  );
  const retryCount = numberOrNull(record.retryCount);
  const retryLimit = numberOrNull(record.retryLimit);
  const retryable = queueState === "retryable_failure"
    || asString(record.failureClassification).toLowerCase() === "network"
    || asString(record.failureClassification).toLowerCase() === "transient";
  const exhausted = queueState === "dead_letter"
    && retryCount !== null
    && retryLimit !== null
    && retryCount >= retryLimit;

  return {
    supplier: firstString(record.supplierName, record.supplierId, record.sourceId, snapshot.supplierName, snapshot.supplierId),
    supplierSku,
    supplierProductId: productId,
    reviewId,
    queue: {
      state: queueState,
      eligibleNow: eligibility.eligibleNow,
      eligibilityReasons: eligibility.reasons,
      createdAt: isoOrNull(record.queueCreatedAt) || isoOrNull(record.createdAt),
      updatedAt: isoOrNull(record.updatedAt),
    },
    lease: {
      active: leaseExpiryMs === null ? null : Boolean(leaseId && leaseExpiryMs > now),
      leaseId,
      acquiredAt: isoOrNull(record.leaseAcquiredAt),
      expiresAt: isoOrNull(record.leaseExpiresAt),
      expired: leaseExpiryMs === null ? null : leaseExpiryMs <= now,
    },
    retry: {
      retryCount,
      retryLimit,
      nextRetryAt: isoOrNull(record.nextRetryAt),
      retryable: hasOwn(record, "retryCount") ? retryable : null,
      exhausted: hasOwn(record, "retryCount") && hasOwn(record, "retryLimit") ? exhausted : null,
    },
    worker: {
      lastAttemptAt,
      lastAttemptResult,
      attemptCount: firstNumber(record.leaseCount),
      health: workerHealth,
    },
    media: {
      sourceImageCount: observation.sourceImageCount,
      managedImageCount: observation.managedImageCount,
      usablePrimaryImage: observation.hasUsablePrimary,
      readiness: observation.readiness,
      lastActivityAt: observation.lastActivityAt || audit.latestAt,
      safeFailureClass: observation.safeFailureClass,
    },
    finalization: {
      assetPersisted,
      readinessProjected: finalizationReadiness,
      reviewStateUpdated,
      auditEvents: audit.names,
    },
    diagnosis: {
      possiblyStuck: observation.possiblyStuck,
      blockingPredicate: eligibility.blockingPredicate,
      nextExpectedTransition: eligibility.nextExpectedTransition,
    },
  };
};

export const findSupplierReviewQueueItemBySku = async (
  db: Firestore,
  supplierSku: string,
): Promise<{ id: string; record: SupplierQueueRecord } | null> => {
  const matches = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const field of ["supplierItemCode", "supplierSku", "sku"]) {
    const snapshot = await db.collection("supplier_review_queue").where(field, "==", supplierSku).limit(3).get();
    snapshot.docs.forEach((document) => matches.set(document.id, document));
  }
  if (matches.size !== 1) return null;
  const document = [...matches.values()][0];
  return { id: document.id, record: document.data() as SupplierQueueRecord };
};
