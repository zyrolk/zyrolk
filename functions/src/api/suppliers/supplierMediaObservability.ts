import { classifySupplierMediaReadiness } from "./supplierMediaReadiness";

export const SUPPLIER_MEDIA_WORKER_CADENCE_MINUTES = 5;
export const SUPPLIER_MEDIA_AGE_THRESHOLDS_MINUTES = {
  fresh: 10,
  aging: 30,
} as const;

export type SupplierMediaOperationalState =
  | "QUEUED"
  | "LEASED"
  | "PROCESSING"
  | "READY"
  | "RETRYABLE_FAILURE"
  | "RETRY_EXHAUSTED"
  | "PERMANENT_FAILURE"
  | "DEAD_LETTER"
  | "MISSING_SOURCE_MEDIA"
  | "UNKNOWN";

export type SupplierMediaUserState =
  | "READY"
  | "PROCESSING"
  | "RETRY_SCHEDULED"
  | "NEEDS_ATTENTION"
  | "SUPPLIER_IMAGE_UNAVAILABLE"
  | "PERMANENT_MEDIA_CONSTRAINT"
  | "LEGACY_UNKNOWN";

export type SupplierMediaAgeClass = "fresh" | "aging" | "stale";
export type SupplierMediaSafeFailureClass =
  | "MEDIA_RETRYABLE"
  | "MEDIA_PERMANENT"
  | "SUPPLIER_IMAGE_UNAVAILABLE"
  | "NEEDS_ATTENTION"
  | "NONE"
  | "UNKNOWN";

export interface SupplierMediaObservability {
  state: SupplierMediaUserState;
  rawState: SupplierMediaOperationalState;
  readiness: "ready" | "blocked" | "unknown";
  sourceImageCount: number | null;
  managedImageCount: number | null;
  hasUsablePrimary: boolean | null;
  blockingIssueCount: number | null;
  retryCount: number | null;
  nextRetryAt: string | null;
  lastActivityAt: string | null;
  processingStartedAt: string | null;
  mediaAgeSeconds: number | null;
  processingAgeSeconds: number | null;
  ageClass: SupplierMediaAgeClass | null;
  possiblyStuck: boolean;
  safeFailureClass: SupplierMediaSafeFailureClass;
  legacy: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const normalized = (value: unknown): string => String(value || "").trim().toLowerCase();

const timestampMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
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

const arrayValues = (value: unknown): unknown[] | null => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value];
  return null;
};

const mediaUrlsFromCandidates = (candidates: unknown[]): { values: string[] | null; evidence: boolean } => {
  let evidence = false;
  let emptyEvidence = false;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    evidence = true;
    const values = arrayValues(candidate)
      ?.map((value) => String(value || "").trim())
      .filter(Boolean);
    if (values && values.length > 0) return { values: [...new Set(values)], evidence: true };
    emptyEvidence = true;
  }
  return { values: emptyEvidence ? [] : null, evidence };
};

const managedMediaFromCandidates = (candidates: unknown[]): { values: Record<string, unknown>[] | null; evidence: boolean } => {
  let evidence = false;
  let emptyEvidence = false;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    evidence = true;
    if (Array.isArray(candidate)) {
      const values = candidate.filter((value): value is Record<string, unknown> => (
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      )).map((value) => asRecord(value));
      if (values.length > 0) return { values, evidence: true };
      emptyEvidence = true;
    }
  }
  return { values: emptyEvidence ? [] : null, evidence };
};

const failureRecords = (value: unknown): Record<string, unknown>[] => (
  Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)).map(asRecord)
    : []
);

const isPermanentFailure = (failure: Record<string, unknown>): boolean => (
  (normalized(failure.code) === "image_too_large"
    || normalized(failure.code) === "image-too-large"
    || normalized(failure.code) === "permanent")
    && failure.retryable === false
);

const safeFailureClassFor = (
  record: Record<string, unknown>,
  sourceImages: string[] | null,
  managedMedia: Record<string, unknown>[] | null,
  failures: Record<string, unknown>[],
  rawState: SupplierMediaOperationalState,
): SupplierMediaSafeFailureClass => {
  if (sourceImages?.length === 0 && (managedMedia?.length || 0) === 0) return "SUPPLIER_IMAGE_UNAVAILABLE";
  if (failures.some(isPermanentFailure)) return "MEDIA_PERMANENT";
  if (failures.some((failure) => failure.retryable === true) || rawState === "RETRYABLE_FAILURE") return "MEDIA_RETRYABLE";
  if (["DEAD_LETTER", "RETRY_EXHAUSTED"].includes(rawState) || failures.length > 0 || normalized(record.mediaStatus) === "failed" || normalized(record.mediaStatus) === "partial") {
    return "NEEDS_ATTENTION";
  }
  if (!sourceImages && !managedMedia && failures.length === 0) return "UNKNOWN";
  return "NONE";
};

const hasOwn = (record: Record<string, unknown>, field: string): boolean => Object.prototype.hasOwnProperty.call(record, field);

export function classifySupplierMediaObservability(
  record: Record<string, unknown>,
  now = Date.now(),
): SupplierMediaObservability {
  const payload = asRecord(record.productPayload);
  const snapshot = asRecord(record.supplierSnapshot);
  const source = mediaUrlsFromCandidates([
    record.mediaSourceImageUrls,
    payload.imageUrls,
    payload.mediaGallery,
    payload.imageUrl,
    snapshot.imageUrls,
    snapshot.mediaGallery,
    snapshot.imageUrl,
  ]);
  const managed = managedMediaFromCandidates([
    record.managedMedia,
    payload.supplierMedia,
    payload.media,
  ]);
  const failures = failureRecords(record.mediaFailures);
  const queueState = normalized(record.queueState);
  const mediaStatus = normalized(record.mediaStatus);
  const mediaReadiness = normalized(record.mediaReadiness);
  const retryCountRaw = Number(record.retryCount);
  const retryLimitRaw = Number(record.retryLimit);
  const retryExhausted = queueState === "dead_letter"
    && Number.isFinite(retryCountRaw)
    && Number.isFinite(retryLimitRaw)
    && retryLimitRaw > 0
    && retryCountRaw >= retryLimitRaw;
  const permanentFailure = failures.some(isPermanentFailure);
  const rawState: SupplierMediaOperationalState = queueState === "queued"
    ? "QUEUED"
    : queueState === "leased"
      ? "LEASED"
      : queueState === "processing"
        ? "PROCESSING"
        : queueState === "retryable_failure"
          ? "RETRYABLE_FAILURE"
          : queueState === "dead_letter"
            ? retryExhausted ? "RETRY_EXHAUSTED" : "DEAD_LETTER"
            : permanentFailure ? "PERMANENT_FAILURE"
            : mediaStatus === "ready" || mediaReadiness.startsWith("publication_safe") || mediaReadiness === "ready"
              ? "READY"
              : source.values?.length === 0 && managed.values?.length === 0
                ? "MISSING_SOURCE_MEDIA"
                : "UNKNOWN";
  const evidencePresent = [
    "mediaStatus",
    "mediaReadiness",
    "mediaFailures",
    "mediaSourceImageUrls",
    "managedMedia",
    "processingStartedAt",
    "mediaProcessedAt",
    "nextRetryAt",
    "retryCount",
  ].some((field) => hasOwn(record, field));
  const legacy = !evidencePresent;
  const supplierId = record.supplierId || snapshot.supplierId || record.sourceId;
  const readinessResult = classifySupplierMediaReadiness({
    supplierId,
    sourceImageUrls: source.values || [],
    managedMedia: managed.values || [],
    mediaFailures: failures,
  });
  const hasUsablePrimary = managed.values === null
    ? null
    : readinessResult.hasUsablePrimary;
  const blockingIssueCount = managed.values === null && source.values === null && failures.length === 0
    ? null
    : readinessResult.blockingFailures.length;
  const nextRetryMs = timestampMs(record.nextRetryAt);
  const retryCountValue = Number(record.retryCount);
  const retryCount = hasOwn(record, "retryCount") && Number.isFinite(retryCountValue)
    ? Math.max(0, retryCountValue)
    : null;
  const processingStartedMs = timestampMs(record.processingStartedAt);
  const activityCandidates = [
    record.updatedAt,
    record.lastActivityAt,
    record.lastLeasedAt,
    record.leaseAcquiredAt,
    record.lastFailureAt,
    record.lastRetryScheduledAt,
    record.mediaProcessedAt,
    record.processingStartedAt,
  ].map(timestampMs).filter((value): value is number => value !== null);
  const lastActivityMs = activityCandidates.length > 0 ? Math.max(...activityCandidates) : null;
  const createdMs = timestampMs(record.createdAt) ?? timestampMs(record.queueCreatedAt);
  const mediaAgeSeconds = createdMs === null ? null : Math.max(0, Math.floor((now - createdMs) / 1000));
  const processingAgeSeconds = processingStartedMs === null ? null : Math.max(0, Math.floor((now - processingStartedMs) / 1000));
  const ageBasisSeconds = processingAgeSeconds ?? (lastActivityMs === null ? null : Math.max(0, Math.floor((now - lastActivityMs) / 1000)));
  const ageClass: SupplierMediaAgeClass | null = ageBasisSeconds === null
    ? null
    : ageBasisSeconds < SUPPLIER_MEDIA_AGE_THRESHOLDS_MINUTES.fresh * 60
      ? "fresh"
      : ageBasisSeconds < SUPPLIER_MEDIA_AGE_THRESHOLDS_MINUTES.aging * 60
        ? "aging"
        : "stale";
  const safeFailureClass = safeFailureClassFor(record, source.values, managed.values, failures, rawState);
  let state: SupplierMediaUserState;
  if (legacy) state = "LEGACY_UNKNOWN";
  else if (safeFailureClass === "SUPPLIER_IMAGE_UNAVAILABLE") state = "SUPPLIER_IMAGE_UNAVAILABLE";
  else if (safeFailureClass === "MEDIA_PERMANENT") state = "PERMANENT_MEDIA_CONSTRAINT";
  else if (rawState === "RETRYABLE_FAILURE" && nextRetryMs !== null && nextRetryMs > now) state = "RETRY_SCHEDULED";
  else if (["QUEUED", "LEASED", "PROCESSING"].includes(rawState)
    || ["queued", "downloading", "processing"].includes(mediaStatus)
    || (source.values?.length || 0) > 0 && (managed.values?.length || 0) === 0 && failures.length === 0 && !readinessResult.publicationSafe) state = "PROCESSING";
  else if (readinessResult.publicationSafe) state = "READY";
  else state = "NEEDS_ATTENTION";
  const leaseExpiresMs = timestampMs(record.leaseExpiresAt);
  const retryScheduled = nextRetryMs !== null && nextRetryMs > now;
  const possiblyStuck = !legacy
    && state === "PROCESSING"
    && ageClass === "stale"
    && !retryScheduled
    && (leaseExpiresMs === null || leaseExpiresMs <= now);
  return {
    state,
    rawState,
    readiness: readinessResult.publicationSafe ? "ready" : evidencePresent ? "blocked" : "unknown",
    sourceImageCount: source.values === null ? null : source.values.length,
    managedImageCount: managed.values === null ? null : managed.values.length,
    hasUsablePrimary,
    blockingIssueCount,
    retryCount,
    nextRetryAt: isoOrNull(record.nextRetryAt),
    lastActivityAt: lastActivityMs === null ? null : new Date(lastActivityMs).toISOString(),
    processingStartedAt: isoOrNull(record.processingStartedAt),
    mediaAgeSeconds,
    processingAgeSeconds,
    ageClass,
    possiblyStuck,
    safeFailureClass,
    legacy,
  };
}

export function supplierReviewMediaMatchesFilter(
  record: Record<string, unknown>,
  filter: "all" | "ready" | "processing" | "issues",
  now = Date.now(),
): boolean {
  if (filter === "all") return true;
  const observation = classifySupplierMediaObservability(record, now);
  if (filter === "ready") return observation.state === "READY";
  if (filter === "processing") return ["PROCESSING", "RETRY_SCHEDULED"].includes(observation.state);
  return ["NEEDS_ATTENTION", "SUPPLIER_IMAGE_UNAVAILABLE", "PERMANENT_MEDIA_CONSTRAINT"].includes(observation.state);
}
