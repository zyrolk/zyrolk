import { createHash } from "crypto";
import { FieldPath, FieldValue, Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { ApiError } from "../api/errors";
import { createSupplierAuditEvent, SupplierAuditActor } from "../api/suppliers/supplierAuditTrail";
import {
  acquireSupplierManagedMedia,
  applyManagedMediaToProductPayload,
  extractSupplierMediaFromRecord,
  MAX_SUPPLIER_GALLERY_IMAGES,
  orderSupplierManagedMedia,
  SupplierManagedMediaAsset,
  SupplierMediaFailure,
  SupplierMediaPipelineDependencies,
  SupplierMediaRetryableError,
  SupplierMediaValidationError,
  supplierMediaRetryDelayMs,
} from "../api/suppliers/supplierMediaPipeline";
import {
  buildSupplierQueueIdentityProjection,
  getSupplierQueueIdentityCandidate,
  resolveSupplierQueueIdentity,
} from "../api/suppliers/supplierQueueIdentity";
import {
  recordSupplierOperationalAlertSafely,
  resolveSupplierMediaOperationalAlertsSafely,
} from "../api/suppliers/supplierOperationalAlerts";
import { classifySupplierMediaReadiness } from "../api/suppliers/supplierMediaReadiness";
import {
  buildSupplierMediaQueueProjection,
  classifySupplierMediaObservability,
  SUPPLIER_MEDIA_QUEUE_CLASS_FIELD,
  SupplierMediaQueueClass,
  supplierReviewMediaMatchesFilter,
} from "../api/suppliers/supplierMediaObservability";
import { isSupplierMediaQueueProjectionActive } from "../api/suppliers/supplierMediaQueueProjection";
import { recordSupplierQueueProcessingDurationMetric } from "../api/suppliers/supplierCloudMonitoring";
import { appLogger } from "../api/logging";
import {
  buildSupplierQueueLifecycle,
  SUPPLIER_QUEUE_DEFAULT_RETRY_LIMIT,
} from "../api/suppliers/supplierQueueLifecycle";
import {
  isDropexLowStockReviewHold,
  lowSupplierStockValidationError,
} from "../api/suppliers/supplierLowStockPolicy";
import {
  hasLegacySupplierDerivedReviewTaxonomy,
  projectLegacySupplierDerivedReviewValidation,
} from "../api/suppliers/supplierReviewTaxonomyAuthority";

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
  mediaDependencies?: Partial<SupplierMediaPipelineDependencies>;
  runtimeDeadlineMs?: number;
  telemetry?: SupplierQueueProcessingTelemetry;
}

export interface SupplierQueueProcessingTelemetry {
  candidatesFetched: number;
  itemsLeased: number;
  itemsStarted: number;
  itemsCompleted: number;
  itemsRetryableFailed: number;
  itemsPermanentFailed: number;
  itemsSkippedByRuntimeBudget: number;
  deadlineReached: boolean;
  lastSelectedQueueCreatedAt: string | null;
  lastSelectedDocumentId: string | null;
}

export interface SupplierReviewQueueMetrics {
  queueDepth: number;
  retryBacklog: number;
  activeWorkers: number;
  oldestQueueAgeMs: number | null;
  averageProcessingLatencyMs: number | null;
}

export interface SupplierQueueRecord extends Record<string, unknown> {
  queueState?: unknown;
  status?: unknown;
  reviewStatus?: unknown;
  decisionAction?: unknown;
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
  mediaQueueClass?: SupplierMediaQueueClass;
  mediaQueueClassVersion?: number;
  mediaSourceImageUrls?: unknown;
}

const DEFAULT_RETRY_LIMIT = SUPPLIER_QUEUE_DEFAULT_RETRY_LIMIT;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export const createSupplierQueueProcessingTelemetry = (): SupplierQueueProcessingTelemetry => ({
  candidatesFetched: 0,
  itemsLeased: 0,
  itemsStarted: 0,
  itemsCompleted: 0,
  itemsRetryableFailed: 0,
  itemsPermanentFailed: 0,
  itemsSkippedByRuntimeBudget: 0,
  deadlineReached: false,
  lastSelectedQueueCreatedAt: null,
  lastSelectedDocumentId: null,
});

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const isCandidateSupplierMediaUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
};

const normalizedSupplierMediaUrls = (
  value: unknown,
  managedUrls: ReadonlySet<string> = new Set(),
  trustedOriginalSupplierUrls: ReadonlySet<string> = new Set(),
): string[] => [...new Set(
  (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((url) => url.trim())
    .filter((url): url is string => isCandidateSupplierMediaUrl(url))
    .filter((url) => trustedOriginalSupplierUrls.has(url)
      || (!managedUrls.has(url) && !isUnprovenManagedStorageUrl(url))),
)];

const supplierMediaFields = (
  record: Record<string, unknown>,
  managedUrls: ReadonlySet<string>,
  trustedOriginalSupplierUrls: ReadonlySet<string>,
): { present: boolean; urls: string[] } => {
  const fields = ["mediaGallery", "imageUrls", "imageUrl"] as const;
  let present = false;
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) continue;
    present = true;
    const urls = normalizedSupplierMediaUrls(record[field], managedUrls, trustedOriginalSupplierUrls);
    if (urls.length > 0) return { present: true, urls };
  }
  return { present, urls: [] };
};

const knownManagedMediaUrls = (managedMedia: unknown): Set<string> => {
  const urls = new Set<string>();
  for (const asset of extractSupplierMediaFromRecord(managedMedia)) {
    for (const value of [asset.firebaseStorageUrl, asset.originalStorageUrl]) {
      const url = asString(value);
      if (url) urls.add(url);
    }
  }
  return urls;
};

const isUnprovenManagedStorageUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "firebasestorage.googleapis.com"
      || hostname === "storage.googleapis.com"
      || hostname.endsWith(".firebasestorage.app");
  } catch {
    return false;
  }
};

/**
 * Resolve source media from current supplier truth before falling back to
 * derived queue fields. A processed/managed URL is never preferred over a
 * current supplier snapshot, and an unproven Firebase Storage URL is not
 * treated as supplier input when no authoritative source is available.
 */
export const supplierReviewQueueSourceImageUrls = (record: Record<string, unknown>): string[] => {
  const snapshot = asRecord(record.supplierSnapshot);
  const payload = asRecord(record.productPayload);
  const supplierMetadata = asRecord(snapshot.supplierMetadata);
  const payloadMetadata = asRecord(payload.supplierMetadata);
  const managedMedia = extractSupplierMediaFromRecord(record.managedMedia);
  const managedUrls = knownManagedMediaUrls(managedMedia);
  const provenanceUrls = managedMedia
    .map((asset) => asString(asset.originalSupplierUrl))
    .filter((url): url is string => isCandidateSupplierMediaUrl(url));
  const trustedOriginalSupplierUrls = new Set(provenanceUrls);

  for (const candidate of [snapshot, supplierMetadata, payload, payloadMetadata]) {
    const media = supplierMediaFields(candidate, managedUrls, trustedOriginalSupplierUrls);
    if (media.present) return media.urls;
  }

  if (provenanceUrls.length > 0) return [...new Set(provenanceUrls)];

  return normalizedSupplierMediaUrls(
    record.mediaSourceImageUrls,
    managedUrls,
    trustedOriginalSupplierUrls,
  );
};

const sourceImageUrls = (record: SupplierQueueRecord): string[] => supplierReviewQueueSourceImageUrls(record);

export interface SupplierQueueManagedMediaResult {
  assets: SupplierManagedMediaAsset[];
  failures: SupplierMediaFailure[];
  reusedExistingQueueMedia: boolean;
  mediaProcessedAt?: string;
}

export interface SupplierReviewApprovalMediaSelection {
  requestedUrls: string[];
  selectedManagedMedia: SupplierManagedMediaAsset[];
  rawSupplierUrls: string[];
  sourceImageUrls: string[];
}

const supplierReviewApprovalAssetBelongsToQueue = (
  asset: SupplierManagedMediaAsset,
  queueItem: SupplierQueueRecord,
): boolean => {
  const snapshot = asRecord(queueItem.supplierSnapshot);
  const expectedSupplierId = asString(queueItem.supplierId) || asString(snapshot.supplierId) || asString(queueItem.sourceId);
  const expectedSourceId = asString(queueItem.sourceId) || asString(snapshot.sourceId) || expectedSupplierId;
  return (!asset.supplierId || !expectedSupplierId || asset.supplierId === expectedSupplierId)
    && (!asset.sourceId || !expectedSourceId || asset.sourceId === expectedSourceId);
};

const supplierReviewApprovalManagedUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "firebasestorage.googleapis.com"
      || hostname === "storage.googleapis.com"
      || hostname.endsWith(".firebasestorage.app");
  } catch {
    return false;
  }
};

const orderedSupplierReviewApprovalAssets = (
  assets: readonly SupplierManagedMediaAsset[],
  requestedUrls: readonly string[] = [],
): SupplierManagedMediaAsset[] => {
  const requestedIndexFor = (asset: SupplierManagedMediaAsset, fallbackIndex: number): number => {
    if (requestedUrls.length === 0) return Number.isFinite(asset.sortOrder) ? asset.sortOrder : fallbackIndex;
    const requestedIndex = requestedUrls.findIndex((url) => (
      url === asset.firebaseStorageUrl || url === asset.originalSupplierUrl
    ));
    return requestedIndex >= 0 ? requestedIndex : requestedUrls.length + fallbackIndex;
  };
  const candidates = assets
    .map((asset, inputIndex) => ({ asset, requestedIndex: requestedIndexFor(asset, inputIndex), inputIndex }))
    .sort((left, right) => left.requestedIndex - right.requestedIndex || left.inputIndex - right.inputIndex);
  const seen = new Set<string>();
  const deduplicated: SupplierManagedMediaAsset[] = [];
  for (const { asset } of candidates) {
    const identity = asset.contentHash || asset.assetId;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    deduplicated.push({ ...asset, isPrimary: false, sortOrder: deduplicated.length });
  }
  return orderSupplierManagedMedia(deduplicated);
};

export const resolveSupplierReviewApprovalMediaSelection = (
  queueItem: SupplierQueueRecord,
  requestedUrlsInput: readonly string[],
): SupplierReviewApprovalMediaSelection => {
  const requestedUrls = [...new Set(requestedUrlsInput.map((url) => String(url || "").trim()).filter(Boolean))];
  const existingAssets = extractSupplierMediaFromRecord(queueItem.managedMedia);
  const assetsByUrl = new Map<string, SupplierManagedMediaAsset>();
  existingAssets.forEach((asset) => {
    for (const url of [asset.firebaseStorageUrl, asset.originalSupplierUrl]) {
      if (url) assetsByUrl.set(url, asset);
    }
  });
  const selected: SupplierManagedMediaAsset[] = [];
  const rawSupplierUrls: string[] = [];
  const sourceImageUrls: string[] = [];
  const selectedAssetIds = new Set<string>();

  for (const url of requestedUrls) {
    const managedAsset = assetsByUrl.get(url);
    if (managedAsset) {
      if (!supplierReviewApprovalAssetBelongsToQueue(managedAsset, queueItem)) {
        throw new ApiError("Selected managed media does not belong to this supplier review item.", 422);
      }
      if (!selectedAssetIds.has(managedAsset.assetId)) {
        selected.push(managedAsset);
        selectedAssetIds.add(managedAsset.assetId);
      }
      sourceImageUrls.push(asString(managedAsset.originalSupplierUrl) || url);
      continue;
    }
    if (supplierReviewApprovalManagedUrl(url)) {
      throw new ApiError("Selected managed media does not belong to this supplier review item.", 422);
    }
    rawSupplierUrls.push(url);
    sourceImageUrls.push(url);
  }

  return {
    requestedUrls,
    selectedManagedMedia: orderedSupplierReviewApprovalAssets(selected, requestedUrls),
    rawSupplierUrls,
    sourceImageUrls,
  };
};

/**
 * Acquires supplier media before a queue item can enter review. The same helper
 * is reused by approval when an administrator changes image URLs in the draft.
 */
export async function ensureSupplierReviewQueueManagedMedia(
  db: Firestore,
  queueItemId: string,
  options: {
    imageUrls?: readonly string[];
    approvalImageUrls?: readonly string[];
    maxImages?: number;
    reprocessIncomplete?: boolean;
    dependencies?: Partial<SupplierMediaPipelineDependencies>;
  } = {},
): Promise<SupplierQueueManagedMediaResult> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  const snapshot = await reference.get();
  if (!snapshot.exists) throw new Error("Supplier review queue item no longer exists.");
  const queueItem = snapshot.data() as SupplierQueueRecord;
  const existingAssets = extractSupplierMediaFromRecord(queueItem.managedMedia);
  const approvalSelection = options.approvalImageUrls === undefined
    ? undefined
    : resolveSupplierReviewApprovalMediaSelection(queueItem, options.approvalImageUrls);
  const requestedUrls = options.imageUrls === undefined ? undefined : [...options.imageUrls].map((url) => String(url || "").trim()).filter(Boolean);
  const existingUrls = existingAssets.map((asset) => asset.firebaseStorageUrl);
  const imageUrls = approvalSelection
    ? approvalSelection.rawSupplierUrls
    : requestedUrls === undefined ? sourceImageUrls(queueItem) : requestedUrls;
  const sourceUrlsForReadiness = approvalSelection?.sourceImageUrls || imageUrls;
  const selectedApprovalAssets = approvalSelection?.selectedManagedMedia || [];
  if (approvalSelection && approvalSelection.rawSupplierUrls.length === 0) {
    return {
      assets: selectedApprovalAssets,
      failures: Array.isArray(queueItem.mediaFailures) ? queueItem.mediaFailures as SupplierMediaFailure[] : [],
      reusedExistingQueueMedia: true,
    };
  }
  const requestedExistingMedia = requestedUrls !== undefined
    && requestedUrls.length === existingUrls.length
    && requestedUrls.every((url, index) => (
      url === existingUrls[index]
      || url === existingAssets[index]?.originalSupplierUrl
    ));
  const canReuseExistingMedia = options.reprocessIncomplete === true
    ? supplierReviewQueueMediaIsHealthy(queueItem)
      && supplierManagedMediaMatchesSourceUrls(existingAssets, imageUrls)
    : existingAssets.length > 0;
  if (!approvalSelection && (options.imageUrls === undefined || requestedExistingMedia) && canReuseExistingMedia) {
    return {
      assets: existingAssets,
      failures: Array.isArray(queueItem.mediaFailures) ? queueItem.mediaFailures as SupplierMediaFailure[] : [],
      reusedExistingQueueMedia: true,
    };
  }
  const productPayload = asRecord(queueItem.productPayload);
  const supplierSnapshot = asRecord(queueItem.supplierSnapshot);
  const sourceId = asString(queueItem.sourceId) || asString(supplierSnapshot.sourceId) || "unknown-source";
  const supplierId = asString(supplierSnapshot.supplierId) || sourceId;
  const productId = asString(productPayload.id) || asString(queueItemId);
  let result;
  try {
    result = await acquireSupplierManagedMedia(db, {
      queueItemId,
      supplierId,
      sourceId,
      productId,
      imageUrls,
      maxImages: Math.min(options.maxImages || MAX_SUPPLIER_GALLERY_IMAGES, MAX_SUPPLIER_GALLERY_IMAGES),
      retryCount: Number(queueItem.retryCount || 0),
    }, options.dependencies);
  } catch (error) {
    if (error instanceof SupplierMediaRetryableError) {
      const validation = asRecord(queueItem.productValidation);
      const existingErrors = Array.isArray(validation.errors) ? validation.errors : [];
      const retryPatch: Record<string, unknown> = {
        managedMedia: existingAssets,
        mediaFailures: error.failures,
        mediaSourceImageUrls: sourceUrlsForReadiness,
        mediaStatus: "failed",
        mediaReadiness: "blocked",
        mediaProcessedAt: new Date().toISOString(),
        productValidation: {
          ...validation,
          readyToPublish: false,
          missingFields: [...new Set([
            ...(Array.isArray(validation.missingFields) ? validation.missingFields.map(String) : []),
            "images",
          ])],
          errors: [
            ...existingErrors.filter((entry) => asString(asRecord(entry).code) !== "managed_media_required"),
            {
              field: "images",
              code: "managed_media_required",
              message: "Managed product media processing failed and will be retried.",
            },
          ],
        },
        supplierSnapshot: {
          ...supplierSnapshot,
          managedMedia: existingAssets,
          mediaFailures: error.failures,
        },
      };
      await reference.set({
        ...retryPatch,
        ...buildSupplierMediaQueueProjection(queueItem, retryPatch),
      }, { merge: true });
    }
    throw error;
  }
  const freshFailures = result.failures.length > 0
    ? result.failures
    : imageUrls.length === 0
      ? (Array.isArray(queueItem.mediaFailures) ? queueItem.mediaFailures as SupplierMediaFailure[] : [])
      : [];
  const initialReadiness = classifySupplierMediaReadiness({
    supplierId,
    sourceImageUrls: sourceUrlsForReadiness,
    managedMedia: approvalSelection
      ? orderedSupplierReviewApprovalAssets([...selectedApprovalAssets, ...result.assets], approvalSelection.requestedUrls)
      : result.assets,
    mediaFailures: freshFailures,
  });
  const preserveExistingManagedMedia = existingAssets.length > 0
    && (!initialReadiness.publicationSafe || result.assets.length === 0);
  const acquiredAndSelectedMedia = approvalSelection
    ? orderedSupplierReviewApprovalAssets([...selectedApprovalAssets, ...result.assets], approvalSelection.requestedUrls)
    : result.assets;
  const effectiveManagedMedia = preserveExistingManagedMedia ? existingAssets : acquiredAndSelectedMedia;
  const managedPayload = applyManagedMediaToProductPayload(productPayload, effectiveManagedMedia);
  // Keep the source URLs in mediaSourceImageUrls/supplierSnapshot for audit;
  // the review payload itself exposes only successful managed URLs.
  const nextPayload = {
    ...productPayload,
    imageUrl: managedPayload.imageUrl,
    imageUrls: managedPayload.imageUrls,
    media: managedPayload.media,
    supplierMedia: managedPayload.supplierMedia,
  };
  const pendingChangePayload = asRecord(queueItem.pendingChangePayload);
  const importPayload = asRecord(queueItem.importPayload);
  const validation = asRecord(queueItem.productValidation);
  const existingErrors = Array.isArray(validation.errors) ? validation.errors : [];
  const mediaReadiness = classifySupplierMediaReadiness({
    supplierId,
    sourceImageUrls: sourceUrlsForReadiness,
    managedMedia: effectiveManagedMedia,
    mediaFailures: freshFailures,
  });
  const mediaError = !mediaReadiness.publicationSafe ? {
    field: "images",
    code: "managed_media_required",
    message: mediaReadiness.hasUsablePrimary && mediaReadiness.usableAssetCount > 0
      ? "Supplier media contains a blocking image failure before publishing."
      : "At least one valid managed primary product image is required before publishing.",
  } : null;
  const errors = [
    ...existingErrors.filter((entry) => asString(asRecord(entry).code) !== "managed_media_required"),
    ...(mediaError ? [mediaError] : []),
  ];
  const missingFields = [...new Set([
    ...(Array.isArray(validation.missingFields) ? validation.missingFields.map(String) : []),
    ...(mediaError ? ["images"] : []),
  ].filter((field) => !(field === "images" && !mediaError)))];
  const mediaProcessedAt = new Date().toISOString();
  const patch: Record<string, unknown> = {
    productPayload: nextPayload,
    managedMedia: effectiveManagedMedia,
    mediaFailures: freshFailures,
    mediaSourceImageUrls: sourceUrlsForReadiness,
    mediaReadiness: mediaReadiness.status,
    mediaStatus: mediaReadiness.publicationSafe ? "ready" : effectiveManagedMedia.length === 0 ? "failed" : "partial",
    mediaProcessedAt,
    mediaDuplicateCount: result.duplicateCount,
    productValidation: {
      ...validation,
      readyToPublish: errors.length === 0,
      missingFields,
      errors,
    },
    supplierSnapshot: {
      ...supplierSnapshot,
      managedMedia: effectiveManagedMedia,
      mediaFailures: freshFailures,
    },
    ...(Object.keys(importPayload).length > 0 ? { importPayload: { ...importPayload, managedMedia: effectiveManagedMedia, mediaFailures: freshFailures } } : {}),
    ...(Object.keys(pendingChangePayload).length > 0 ? {
      pendingChangePayload: {
        ...pendingChangePayload,
        productPayload: nextPayload,
        managedMedia: effectiveManagedMedia,
        mediaFailures: freshFailures,
      },
    } : {}),
  };
  await reference.set({
    ...patch,
    ...buildSupplierMediaQueueProjection(queueItem, patch),
  }, { merge: true });
  // Queue workers resolve only after completion changes the queue back to
  // review_pending. The resolver intentionally fences processing records.
  if (mediaReadiness.publicationSafe && String(queueItem.queueState || "").toLowerCase() !== "processing") {
    await resolveSupplierMediaOperationalAlertsSafely(db, { supplierId, queueItemId, mediaProcessedAt });
  }
  return { assets: effectiveManagedMedia, failures: freshFailures, reusedExistingQueueMedia: false, mediaProcessedAt };
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

/**
 * One lifecycle interpretation for both review listing and server-authorized
 * refresh. Legacy pending documents intentionally remain readable as
 * review_pending until their normal write path adds current lifecycle fields.
 */
export const supplierReviewQueueStateFor = (record: Record<string, unknown>): SupplierQueueState => stateFor(record as SupplierQueueRecord);

export const reviewRecordIsRefreshable = (record: Record<string, unknown>): boolean => (
  !reviewRecordIsTerminalDecision(record as SupplierQueueRecord)
  && supplierReviewQueueStateFor(record) === "review_pending"
  && ["pending", ""].includes(normalizedReviewValue(record.status))
);

const nextRetryAt = (attempt: number, now: number): string => new Date(now + supplierMediaRetryDelayMs(attempt)).toISOString();

export { buildSupplierQueueLifecycle };

export function supplierReviewSourceImageUrls(product: { mediaGallery?: readonly string[] }): string[] {
  return [...(product.mediaGallery || [])].map((url) => String(url || "").trim()).filter(Boolean);
}

export function supplierManagedMediaMatchesSourceUrls(
  managedMedia: unknown,
  sourceUrls: readonly string[],
): boolean {
  const assets = extractSupplierMediaFromRecord(managedMedia);
  if (assets.length === 0 || sourceUrls.length === 0) return false;
  if (assets.length !== sourceUrls.length) return false;
  return sourceUrls.every((url, index) => {
    const asset = assets[index];
    return Boolean(asset?.firebaseStorageUrl) && (
      url === asset.originalSupplierUrl || url === asset.firebaseStorageUrl
    );
  });
}

export function supplierManagedMediaMatchesSuccessfulSourceUrls(
  managedMedia: unknown,
  sourceUrls: readonly string[],
  mediaFailures: unknown,
): boolean {
  const failedUrls = new Set((Array.isArray(mediaFailures) ? mediaFailures : [])
    .map((failure) => asString(asRecord(failure).originalSupplierUrl))
    .filter(Boolean));
  return supplierManagedMediaMatchesSourceUrls(
    managedMedia,
    sourceUrls.filter((url) => !failedUrls.has(url)),
  );
}

export function supplierReviewQueueMediaIsReady(managedMedia: unknown): boolean {
  const assets = extractSupplierMediaFromRecord(managedMedia);
  return assets.length > 0 && assets.every((asset) => /^https:\/\/\S+$/u.test(asset.firebaseStorageUrl));
}

export function supplierReviewQueueMediaIsHealthy(record: Record<string, unknown>): boolean {
  if (String(record.mediaStatus || "").toLowerCase() !== "ready") return false;
  const mediaFailures = Array.isArray(record.mediaFailures) ? record.mediaFailures : [];
  return mediaFailures.length === 0 && supplierReviewQueueMediaIsReady(record.managedMedia);
}

/** Resolves the canonical managed object path across current and legacy shapes. */
export function supplierReviewQueueStoragePath(record: Record<string, unknown>): string {
  const variants = record.variants && typeof record.variants === "object" && !Array.isArray(record.variants)
    ? record.variants as Record<string, unknown>
    : {};
  const large = variants.large && typeof variants.large === "object" && !Array.isArray(variants.large)
    ? variants.large as Record<string, unknown>
    : {};
  return String(large.storagePath || record.originalStoragePath || record.storagePath || "").trim();
}

export async function decorateSupplierReviewQueueAdminMedia(
  items: Array<Record<string, unknown> & { id: string }>,
  signStoragePath?: (storagePath: string) => Promise<string>,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  let signer = signStoragePath;
  if (!signer) {
    // Unit tests and non-function tooling use synthetic Storage records. Only
    // the deployed API should mint short-lived admin review URLs.
    if (process.env.NODE_ENV !== "production" && !process.env.K_SERVICE && !process.env.FUNCTION_TARGET) return items;
    const bucket = (() => {
      try { return getStorage().bucket(); } catch { return null; }
    })();
    if (!bucket) return items;
    signer = async (storagePath: string) => {
      const [url] = await bucket.file(storagePath).getSignedUrl({
        action: "read",
        version: "v4",
        expires: Date.now() + 15 * 60 * 1000,
      });
      return url;
    };
  }
  return Promise.all(items.map(async (item) => {
    const managed = Array.isArray(item.managedMedia) ? item.managedMedia : [];
    if (managed.length === 0) return item;
    const decorated = await Promise.all(managed.map(async (asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return asset;
      const record = asset as Record<string, unknown>;
      const storagePath = supplierReviewQueueStoragePath(record);
      if (!storagePath) return record;
      try {
        return { ...record, adminReviewUrl: await signer(storagePath) };
      } catch (error) {
        appLogger.warn("Supplier review media signing failed.", {
          queueItemId: item.id,
          assetId: typeof record.assetId === "string" ? record.assetId : undefined,
          reason: "signed_url_generation_failed",
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return record;
      }
    }));
    return { ...item, managedMedia: decorated };
  }));
}

export interface SupplierReviewQueueUpsertLifecycle {
  lifecycleFields: Record<string, unknown>;
  preserveReviewPending: boolean;
  requeueForMedia: boolean;
  preservedManagedMedia?: SupplierManagedMediaAsset[];
}

/** Preserves review_pending and managed media when a resync does not require media refresh. */
export function resolveSupplierReviewQueueUpsertLifecycle(input: {
  existing?: Record<string, unknown>;
  sourceUrls: readonly string[];
  queueCreatedAt: string;
}): SupplierReviewQueueUpsertLifecycle {
  const existing = input.existing;
  if (!existing || Object.keys(existing).length === 0) {
    return {
      lifecycleFields: buildSupplierQueueLifecycle(input.queueCreatedAt),
      preserveReviewPending: false,
      requeueForMedia: true,
    };
  }
  const state = String(existing.queueState || "").toLowerCase();
  const managedMedia = existing.managedMedia;
  const readiness = classifySupplierMediaReadiness({
    supplierId: existing.supplierId || asRecord(existing.supplierSnapshot).supplierId || existing.sourceId,
    sourceImageUrls: input.sourceUrls,
    managedMedia,
    mediaFailures: existing.mediaFailures,
  });
  const sourceMediaMatches = supplierManagedMediaMatchesSourceUrls(managedMedia, input.sourceUrls)
    || (readiness.publicationSafe
      && supplierManagedMediaMatchesSuccessfulSourceUrls(managedMedia, input.sourceUrls, existing.mediaFailures));
  const mediaFailed = ["failed", "partial"].includes(String(existing.mediaStatus || "").toLowerCase())
    || state === "retryable_failure"
    || state === "dead_letter";
  const mediaReady = supplierReviewQueueMediaIsReady(managedMedia)
    && sourceMediaMatches;
  const imagesChanged = !sourceMediaMatches;
  const legacyHealthyMedia = String(existing.mediaStatus || "").toLowerCase() === "ready"
    && (!Array.isArray(existing.mediaFailures) || existing.mediaFailures.length === 0)
    && mediaReady;
  const mediaIncomplete = !legacyHealthyMedia && (mediaFailed || !readiness.publicationSafe || !mediaReady);
  if (state === "review_pending" && mediaReady && !imagesChanged && !mediaIncomplete) {
    return {
      lifecycleFields: {
        queueState: "review_pending" satisfies SupplierQueueState,
        retryCount: Number(existing.retryCount || 0),
        retryLimit: Number(existing.retryLimit || DEFAULT_RETRY_LIMIT),
        nextRetryAt: existing.nextRetryAt || existing.queueCreatedAt || input.queueCreatedAt,
        queueCreatedAt: existing.queueCreatedAt || input.queueCreatedAt,
      },
      preserveReviewPending: true,
      requeueForMedia: false,
      preservedManagedMedia: extractSupplierMediaFromRecord(managedMedia),
    };
  }
  if (imagesChanged || mediaFailed || mediaIncomplete || !mediaReady) {
    return {
      lifecycleFields: buildSupplierQueueLifecycle(input.queueCreatedAt),
      preserveReviewPending: false,
      requeueForMedia: true,
    };
  }
  return {
    lifecycleFields: {
      queueState: existing.queueState,
      retryCount: Number(existing.retryCount || 0),
      retryLimit: Number(existing.retryLimit || DEFAULT_RETRY_LIMIT),
      nextRetryAt: existing.nextRetryAt || existing.queueCreatedAt || input.queueCreatedAt,
      queueCreatedAt: existing.queueCreatedAt || input.queueCreatedAt,
    },
    preserveReviewPending: false,
    requeueForMedia: false,
    preservedManagedMedia: extractSupplierMediaFromRecord(managedMedia),
  };
}

export function supplierReviewQueueDecisionStates(): ReadonlySet<string> {
  return new Set(["approved", "rejected", "suppressed"]);
}

export function classifySupplierQueueFailure(error: unknown): SupplierQueueFailureClassification {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  if (name.includes("supplierurlvalidation") || /blocked|allowlist|ssrf|security/.test(message)) return "security";
  if (name.includes("suppliermediavalidation") || /validation|invalid supplier product|category is required|product payload/.test(message)) return "validation";
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

export type SupplierQueueEligibilityReason =
  | "ELIGIBLE_NOW"
  | "EXPIRED_LEASE"
  | "QUEUE_STATE_NOT_ELIGIBLE"
  | "ACTIVE_LEASE"
  | "LEASE_NOT_EXPIRED"
  | "RETRY_NOT_DUE"
  | "RETRY_EXHAUSTED"
  | "PERMANENT_FAILURE"
  | "NO_SOURCE_MEDIA"
  | "ALREADY_READY"
  | "UNKNOWN_STATE";

export interface SupplierQueueEligibilityDiagnosis {
  eligibleNow: boolean | null;
  reasons: SupplierQueueEligibilityReason[];
  blockingPredicate: string | null;
  nextExpectedTransition: string | null;
}

const hasOwnQueueField = (record: SupplierQueueRecord, field: string): boolean => (
  Object.prototype.hasOwnProperty.call(record, field)
);

const hasPermanentQueueFailure = (record: SupplierQueueRecord): boolean => (
  ["permanent", "validation", "security"].includes(asString(record.failureClassification).toLowerCase())
);

/**
 * Explains the same lifecycle gates used by the scheduled worker. This is a
 * read-only interpretation helper; it does not lease, recover, or otherwise
 * change a queue item.
 */
export function explainSupplierQueueEligibility(
  record: SupplierQueueRecord,
  now = Date.now(),
): SupplierQueueEligibilityDiagnosis {
  const state = asString(record.queueState).toLowerCase();
  const sourceUrls = sourceImageUrls(record);
  const sourceReason = sourceUrls.length === 0 ? ["NO_SOURCE_MEDIA" as const] : [];

  if (!state) {
    return {
      eligibleNow: null,
      reasons: ["UNKNOWN_STATE"],
      blockingPredicate: "queueState is not recorded; the worker's state-specific query cannot select this record.",
      nextExpectedTransition: "Record a durable queueState and due-time field before worker selection can be evaluated.",
    };
  }

  if (state === "review_pending") {
    const mediaReady = supplierReviewQueueMediaIsHealthy(record);
    return {
      eligibleNow: false,
      reasons: mediaReady ? ["ALREADY_READY"] : ["QUEUE_STATE_NOT_ELIGIBLE"],
      blockingPredicate: "queueState is review_pending; the worker only recovers leased/processing items and selects queued/retryable_failure items.",
      nextExpectedTransition: mediaReady ? "No worker transition is expected; this item is already ready for review." : "An explicit review-queue lifecycle transition is required.",
    };
  }

  if (state === "queued" || state === "retryable_failure") {
    if (!hasOwnQueueField(record, "nextRetryAt") || toMillis(record.nextRetryAt) <= 0) {
      return {
        eligibleNow: null,
        reasons: ["UNKNOWN_STATE"],
        blockingPredicate: "nextRetryAt is not recorded; the scheduled worker query requires a comparable due timestamp.",
        nextExpectedTransition: "Persist a due timestamp through the normal queue lifecycle.",
      };
    }
    if (toMillis(record.nextRetryAt) > now) {
      return {
        eligibleNow: false,
        reasons: ["RETRY_NOT_DUE"],
        blockingPredicate: "nextRetryAt is later than the diagnostic time.",
        nextExpectedTransition: new Date(toMillis(record.nextRetryAt)).toISOString(),
      };
    }
    return {
      eligibleNow: true,
      reasons: ["ELIGIBLE_NOW", ...sourceReason],
      blockingPredicate: null,
      nextExpectedTransition: sourceUrls.length === 0
        ? "The worker may select this item; it will remain a supplier-image data gap unless source media appears."
        : "The next worker run may acquire the queue lease.",
    };
  }

  if (state === "leased" || state === "processing") {
    const leaseExpiry = toMillis(record.leaseExpiresAt);
    if (leaseExpiry <= 0) {
      return {
        eligibleNow: null,
        reasons: ["UNKNOWN_STATE"],
        blockingPredicate: "leaseExpiresAt is not recorded; expired-lease recovery cannot safely select this record.",
        nextExpectedTransition: "A durable lease expiry is required before recovery eligibility can be evaluated.",
      };
    }
    if (leaseExpiry > now) {
      return {
        eligibleNow: false,
        reasons: ["ACTIVE_LEASE", "LEASE_NOT_EXPIRED"],
        blockingPredicate: "The queue item has an active lease that has not expired.",
        nextExpectedTransition: new Date(leaseExpiry).toISOString(),
      };
    }
    return {
      eligibleNow: true,
      reasons: ["ELIGIBLE_NOW", "EXPIRED_LEASE", ...sourceReason],
      blockingPredicate: null,
      nextExpectedTransition: "The next worker recovery pass may record a retryable failure or dead-letter outcome.",
    };
  }

  if (state === "dead_letter") {
    const retryCount = retryCountFor(record);
    const retryLimit = retryLimitFor(record);
    const exhausted = retryCount >= retryLimit;
    return {
      eligibleNow: false,
      reasons: [
        ...(hasPermanentQueueFailure(record) ? ["PERMANENT_FAILURE" as const] : []),
        ...(exhausted ? ["RETRY_EXHAUSTED" as const] : []),
        ...(!hasPermanentQueueFailure(record) && !exhausted ? ["QUEUE_STATE_NOT_ELIGIBLE" as const] : []),
      ],
      blockingPredicate: "queueState is dead_letter; scheduled processing excludes terminal failures.",
      nextExpectedTransition: "Only the existing explicit administrative retry workflow can requeue this item.",
    };
  }

  return {
    eligibleNow: false,
    reasons: ["QUEUE_STATE_NOT_ELIGIBLE"],
    blockingPredicate: `queueState ${state} is not selected by the scheduled worker.`,
    nextExpectedTransition: "No scheduled media transition is expected for this terminal or suppressed state.",
  };
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
      transaction.set(reference, {
        ...failure.data,
        ...buildSupplierMediaQueueProjection(record, failure.data, now),
      }, { merge: true });
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
    const leasePatch = {
      queueState: "leased" satisfies SupplierQueueState,
      leaseOwner: workerId,
      leaseId,
      leaseAcquiredAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
      lastLeasedAt: new Date(now).toISOString(),
      leaseCount: Number(record.leaseCount || 0) + 1,
    };
    transaction.set(reference, {
      ...leasePatch,
      ...buildSupplierMediaQueueProjection(record, leasePatch, now),
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
    if (!record || supplierReviewQueueDecisionStates().has(stateFor(record))) {
      throw new Error("Supplier queue item is no longer processable.");
    }
    if (stateFor(record) !== "leased" || asString(record.leaseOwner) !== workerId || isSupplierQueueLeaseExpired(record, now)) {
      throw new Error("Supplier queue lease is no longer owned by this worker.");
    }
    const processingPatch = {
      queueState: "processing" satisfies SupplierQueueState,
      processingStartedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + DEFAULT_LEASE_MS).toISOString(),
      leaseHeartbeatAt: new Date(now).toISOString(),
    };
    transaction.set(reference, {
      ...processingPatch,
      ...buildSupplierMediaQueueProjection(record, processingPatch, now),
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
    if (!record) throw new Error("Supplier queue lease is no longer owned by this worker.");
    const currentState = stateFor(record);
    if (supplierReviewQueueDecisionStates().has(currentState)) return;
    if (currentState !== "processing" || asString(record.leaseOwner) !== workerId || isSupplierQueueLeaseExpired(record, now)) {
      throw new Error("Supplier queue lease is no longer owned by this worker.");
    }
    const importPayload = asRecord(record.importPayload);
    if (Object.keys(importPayload).length > 0) transaction.set(importReference, importPayload, { merge: true });
    const pendingChangePayload = asRecord(record.pendingChangePayload);
    if (Object.keys(pendingChangePayload).length > 0) transaction.set(pendingReference, pendingChangePayload, { merge: true });
    const completionPatch = {
      queueState: "review_pending" satisfies SupplierQueueState,
      status: "Pending",
      completedAt: new Date(now).toISOString(),
      completedBy: workerId,
      leaseOwner: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
      importPayload: FieldValue.delete(),
      pendingChangePayload: FieldValue.delete(),
    };
    transaction.set(reviewReference, {
      ...completionPatch,
      ...buildSupplierMediaQueueProjection(record, { queueState: completionPatch.queueState }, now),
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
    const validation = asRecord(record.productValidation);
    const existingErrors = Array.isArray(validation.errors) ? validation.errors : [];
    const mediaFailed = existingErrors.some((entry) => asString(asRecord(entry).code) === "managed_media_required")
      || (error instanceof Error && error.name === "SupplierMediaRetryableError");
    const mediaMessage = failure.state === "dead_letter"
      ? "Managed product media processing failed permanently. An administrator can retry from Product Review."
      : "Managed product media processing failed and will be retried.";
    const nextValidation = mediaFailed
      ? {
        ...validation,
        readyToPublish: false,
        missingFields: [...new Set([
          ...(Array.isArray(validation.missingFields) ? validation.missingFields.map(String) : []),
          "images",
        ])],
        errors: [
          ...existingErrors.filter((entry) => asString(asRecord(entry).code) !== "managed_media_required"),
          {
            field: "images",
            code: "managed_media_required",
            message: mediaMessage,
          },
        ],
      }
      : null;
    const failurePatch = {
      ...failure.data,
      ...(nextValidation ? { productValidation: nextValidation } : {}),
    };
    transaction.set(reference, {
      ...failurePatch,
      ...buildSupplierMediaQueueProjection(record, failurePatch, now),
    }, { merge: true });
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
    const requiresManagedMedia = processingRecord.managedMediaRequired === true;
    let managedMediaResult: SupplierQueueManagedMediaResult | null = null;
    if (sourceImageUrls(processingRecord).length > 0 || extractSupplierMediaFromRecord(processingRecord.managedMedia).length > 0) {
      managedMediaResult = await ensureSupplierReviewQueueManagedMedia(db, queueItemId, {
        dependencies: control.mediaDependencies,
        reprocessIncomplete: true,
      });
    }
    // Fail closed only when no usable managed asset exists. Partial per-URL
    // failures must not permanently block review when at least one image succeeded.
    if (requiresManagedMedia && (
      !managedMediaResult
      || managedMediaResult.assets.length === 0
    )) {
      throw new SupplierMediaValidationError("Supplier Portal managed media is incomplete and cannot enter administrator review.");
    }
    await control.verifyWorkerOwnership?.();
    sendHeartbeat();
    await heartbeatInFlight;
    if (leaseLost) throw new Error("Supplier queue lease was lost during processing.");
    await control.verifyWorkerOwnership?.();
    await completeSupplierQueueItem(db, queueItemId, workerId, currentTime());
    if (managedMediaResult?.mediaProcessedAt) {
      const supplierSnapshot = asRecord(processingRecord.supplierSnapshot);
      const supplierId = asString(supplierSnapshot.supplierId)
        || asString(processingRecord.sourceId)
        || "unknown-source";
      await resolveSupplierMediaOperationalAlertsSafely(db, {
        supplierId,
        queueItemId,
        mediaProcessedAt: managedMediaResult.mediaProcessedAt,
      });
    }
    return { queueItemId, outcome: "completed", state: "review_pending" };
  } catch (error) {
    const currentSnapshot = await db.collection("supplier_review_queue").doc(queueItemId).get();
    const terminalState = currentSnapshot.exists
      ? stateFor(currentSnapshot.data() as SupplierQueueRecord)
      : null;
    if (terminalState && supplierReviewQueueDecisionStates().has(terminalState)) {
      return { queueItemId, outcome: "skipped", state: terminalState };
    }
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

export async function recoverExpiredSupplierReviewQueueLeases(
  db: Firestore,
  now = Date.now(),
  limit = 100,
  control: Pick<SupplierQueueProcessingControl, "currentTime" | "runtimeDeadlineMs" | "telemetry"> = {},
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  const snapshots = await Promise.all(["leased", "processing"].map((queueState) => db.collection("supplier_review_queue")
    .where("queueState", "==", queueState)
    .where("leaseExpiresAt", "<=", nowIso)
    .orderBy("leaseExpiresAt", "asc")
    .orderBy("queueCreatedAt", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(limit)
    .get()));
  const documents = [...new Map(snapshots.flatMap((snapshot) => snapshot.docs).map((document) => [document.id, document])).values()]
    .sort((left, right) => {
      const leaseExpiryOrder = String(left.data().leaseExpiresAt || "").localeCompare(String(right.data().leaseExpiresAt || ""));
      if (leaseExpiryOrder) return leaseExpiryOrder;
      const queueCreatedOrder = String(left.data().queueCreatedAt || "").localeCompare(String(right.data().queueCreatedAt || ""));
      return queueCreatedOrder || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
  let recovered = 0;
  const currentTime = control.currentTime || Date.now;
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    if (control.runtimeDeadlineMs !== undefined && currentTime() >= control.runtimeDeadlineMs) {
      if (control.telemetry) {
        control.telemetry.deadlineReached = true;
        control.telemetry.itemsSkippedByRuntimeBudget += documents.length - documentIndex;
      }
      break;
    }
    const document = documents[documentIndex];
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
    .orderBy(FieldPath.documentId(), "asc")
    .limit(perStateLimit)
    .get()));
  const documents = [...new Map(snapshots.flatMap((snapshot) => snapshot.docs).map((document) => [document.id, document])).values()]
    .sort((left, right) => {
      const nextRetryOrder = String(left.data().nextRetryAt || "").localeCompare(String(right.data().nextRetryAt || ""));
      if (nextRetryOrder) return nextRetryOrder;
      const queueCreatedOrder = String(left.data().queueCreatedAt || "").localeCompare(String(right.data().queueCreatedAt || ""));
      return queueCreatedOrder || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
  const results: SupplierQueueProcessResult[] = [];
  const currentTime = control.currentTime || Date.now;
  const telemetry = control.telemetry || createSupplierQueueProcessingTelemetry();
  telemetry.candidatesFetched = documents.length;
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    const document = documents[documentIndex];
    if (control.runtimeDeadlineMs !== undefined && currentTime() >= control.runtimeDeadlineMs) {
      telemetry.deadlineReached = true;
      telemetry.itemsSkippedByRuntimeBudget += documents.length - documentIndex;
      break;
    }
    await control.verifyWorkerOwnership?.();
    const itemStartedAt = currentTime();
    telemetry.lastSelectedQueueCreatedAt = String(document.data().queueCreatedAt || "") || null;
    telemetry.lastSelectedDocumentId = document.id;
    const result = await processSupplierReviewQueueItem(db, document.id, workerId, itemStartedAt, {
      ...control,
      currentTime,
    });
    results.push(result);
    if (result.outcome !== "skipped") {
      telemetry.itemsLeased += 1;
      telemetry.itemsStarted += 1;
      if (result.outcome === "completed") telemetry.itemsCompleted += 1;
      if (result.outcome === "retryable_failure") telemetry.itemsRetryableFailed += 1;
      if (result.outcome === "dead_letter") telemetry.itemsPermanentFailed += 1;
    }
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
export type SupplierReviewQueueSort = "created" | "updated";
export type SupplierReviewBusinessFilter =
  | "new_products"
  | "product_updates"
  | "removed_products"
  | "conflicts"
  | "needs_attention"
  | "low_stock_hold"
  | "approved_history";

export type SupplierReviewMediaFilter = "all" | "ready" | "processing" | "issues";
export type SupplierReviewSearchMode = "exact";

export interface SupplierReviewQueryModel {
  view: "review";
  state: SupplierReviewQueuePageState;
  businessFilter?: SupplierReviewBusinessFilter;
  mediaFilter: SupplierReviewMediaFilter;
  search: string;
  searchMode: SupplierReviewSearchMode;
  sort: SupplierReviewQueueSort;
  pageSize: 25 | 50 | 100;
}

export interface SupplierReviewCursorToken {
  version: 1;
  page: number;
  anchorId: string | null;
  previousToken: string | null;
  fingerprint: string;
  queryRevision: string;
  sort: SupplierReviewQueueSort;
  sortValue: string | null;
}

export interface SupplierReviewReadModelPage extends SupplierQueuePageResult {
  page: number;
  pageSize: number;
  totalCount: number | null;
  totalPages: number | null;
  countStatus: "exact" | "unavailable";
  countReason?: string;
  nextCursor: string | null;
  previousCursor: string | null;
  queryFingerprint: string;
  queryRevision: string;
  generatedAt: string;
  searchCapabilities: {
    exactSupplierIdentity: boolean;
    productNamePrefix: false;
  };
  mediaSummary: SupplierReviewMediaSummary;
}

export interface SupplierReviewMediaSummary {
  countStatus: "partial" | "unavailable";
  counts: {
    ready: number | null;
    processing: number | null;
    retryScheduled: number | null;
    needsAttention: number | null;
    supplierImageUnavailable: number | null;
    permanentMediaIssue: number | null;
    legacyUnknown: number | null;
  };
  oldestProcessingAgeSeconds: number | null;
  possiblyStuckCount: number | null;
  unavailableReasons?: string[];
}

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
  if (state === "history") return [
    "Approved", "Rejected", "Pending", "CONFLICT",
    "approved", "rejected", "pending", "conflict",
    "APPROVED", "REJECTED", "PENDING", "SUPPRESSED", "DELETED", "DISMISSED",
    "Suppressed", "suppressed", "Deleted", "deleted", "Dismissed", "dismissed",
  ];
  if (state === "review_pending") return ["Pending", "pending"];
  return ["Pending", "CONFLICT", "pending", "conflict"];
};

const reviewRecordMatchesState = (record: SupplierQueueRecord, state: SupplierReviewQueuePageState): boolean => {
  const queueState = stateFor(record);
  if (state === "history") return reviewRecordIsTerminalDecision(record);
  if (reviewRecordIsTerminalDecision(record)) return false;
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

const supplierReviewRecordStockKnown = (record: SupplierQueueRecord): boolean => {
  const payload = asRecord(record.productPayload);
  const snapshot = asRecord(record.supplierSnapshot);
  const payloadMetadata = asRecord(payload.supplierMetadata);
  const snapshotMetadata = asRecord(snapshot.supplierMetadata);
  const providedFields = Array.isArray(snapshot.providedFields) ? snapshot.providedFields : [];
  return payloadMetadata.supplierStockAvailable === true
    || snapshotMetadata.supplierStockAvailable === true
    || providedFields.includes("stock")
    || providedFields.includes("inventoryLevel");
};

/**
 * Product liveness as observed when the record was last written. Current
 * records persist comparison.matchedProductLive. Legacy records fall back to
 * the observation-time match flags: a record that observed no product is not
 * live, while a legacy record that observed a product keeps its previous
 * unheld presentation. matchedProductId is never used because it can be copied
 * from an offer whose product does not exist. Approval re-reads the product.
 */
const supplierReviewRecordProductLive = (record: SupplierQueueRecord): boolean => {
  const comparison = asRecord(record.comparison);
  if (typeof comparison.matchedProductLive === "boolean") return comparison.matchedProductLive;
  return comparison.matchFound === true || asRecord(record.approvalBaseline).exists === true;
};

/**
 * Every field read by the terminal-decision, conflict, removal and low-stock
 * hold predicates. Projected reads that classify review records must select
 * all of them so a count agrees with the business filter.
 */
export const SUPPLIER_REVIEW_CLASSIFICATION_FIELDS = [
  "status",
  "reviewStatus",
  "queueState",
  "decisionAction",
  "decisionPendingRevision",
  "supplierOfferPendingRevision",
  "sourceId",
  "stock",
  "comparisonStatus",
  "comparison.comparisonStatus",
  "comparison.matchedProductLive",
  "comparison.matchFound",
  "approvalBaseline.exists",
  "categoryMapping.autoSelected",
  "categoryMapping.targetCategoryId",
  "productPayload.category",
  "productPayload.supplierFieldOwnership.category",
  "productPayload.supplierFieldOwnership.subcategory",
  "productPayload.stock",
  "productPayload.supplierMetadata.supplierStockAvailable",
  "supplierSnapshot.inventoryLevel",
  "supplierSnapshot.supplierMetadata.supplierStockAvailable",
  "supplierSnapshot.providedFields",
] as const;

export const supplierReviewRecordIsLowStockHold = (record: SupplierQueueRecord): boolean => {
  if (reviewRecordIsTerminalDecision(record)) return false;
  const payload = asRecord(record.productPayload);
  const snapshot = asRecord(record.supplierSnapshot);
  return isDropexLowStockReviewHold({
    source: record.sourceId,
    productLive: supplierReviewRecordProductLive(record),
    stock: record.stock ?? payload.stock ?? snapshot.inventoryLevel,
    stockKnown: supplierReviewRecordStockKnown(record),
  });
};

export const projectSupplierReviewLowStockHold = <T extends SupplierQueueRecord>(
  record: T,
  categoryRequiresSubcategory = false,
): T => {
  const projectedRecord = projectLegacySupplierDerivedReviewValidation(record, categoryRequiresSubcategory) as T;
  const lowStockHold = supplierReviewRecordIsLowStockHold(projectedRecord);
  const validation = asRecord(projectedRecord.productValidation);
  const existingErrors = Array.isArray(validation.errors) ? validation.errors : [];
  const nonLowStockErrors = existingErrors.filter((error) => (
    asRecord(error).code !== "LOW_SUPPLIER_STOCK_FOR_PUBLICATION"
  ));
  const existingMissingFields = Array.isArray(validation.missingFields)
    ? validation.missingFields.map((field) => String(field))
    : [];
  const missingFields = lowStockHold
    ? [...new Set([...existingMissingFields, "stock"])]
    : validation.lowStockHold === true
      ? existingMissingFields.filter((field) => field !== "stock")
      : existingMissingFields;
  const errors = lowStockHold
    ? [...nonLowStockErrors, lowSupplierStockValidationError()]
    : nonLowStockErrors;
  const wasOnlyLowStockBlock = validation.lowStockHold === true
    && missingFields.length === 0
    && errors.length === 0;
  return {
    ...projectedRecord,
    productValidation: {
      ...validation,
      lowStockHold,
      readyToPublish: lowStockHold ? false : wasOnlyLowStockBlock ? true : validation.readyToPublish,
      missingFields,
      errors,
    },
  } as T;
};

type SupplierReviewCategoryRequirements = ReadonlyMap<string, boolean>;

const supplierReviewCategoryId = (record: SupplierQueueRecord): string => (
  asString(asRecord(record.productPayload).category)
);

const loadSupplierReviewCategoryRequirements = async (db: Firestore): Promise<Map<string, boolean>> => {
  const snapshot = await db.collection("categories").get();
  return new Map(snapshot.docs.map((document) => {
    const data = asRecord(document.data());
    const subcategories = Array.isArray(data.subcategories) ? data.subcategories : [];
    const hasActiveSubcategory = subcategories.some((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).isActive !== false
    ));
    return [
      document.id,
      data.isActive === true && data.taxonomyCandidate !== true && hasActiveSubcategory,
    ] as const;
  }));
};

const reviewRecordIsConflict = (record: SupplierQueueRecord): boolean => (
  normalizedReviewValue(record.status) === "conflict"
  || normalizedReviewValue(record.reviewStatus) === "conflict"
  || normalizedReviewValue(record.queueState) === "conflict"
);

export const reviewRecordIsApproved = (record: SupplierQueueRecord): boolean => (
  normalizedReviewValue(record.status) === "approved"
  || normalizedReviewValue(record.reviewStatus) === "approved"
  || normalizedReviewValue(record.queueState) === "approved"
);

/**
 * An administrator decision belongs to the supplier observation revision it
 * was made against. When a newer observation has been queued the decision is
 * stale and no longer terminal. A decision recorded without a revision stays
 * current only while the record also has no pending revision.
 */
export const reviewRecordDecisionIsCurrent = (record: Record<string, unknown>): boolean => {
  if (!["approved", "rejected", "deleted", "dismissed", "suppressed"].includes(normalizedReviewValue(record.decisionAction))) {
    return false;
  }
  const decisionRevision = String(record.decisionPendingRevision || "").trim();
  const pendingRevision = String(record.supplierOfferPendingRevision || "").trim();
  return decisionRevision ? decisionRevision === pendingRevision : !pendingRevision;
};

export const reviewRecordIsTerminalDecision = (record: SupplierQueueRecord): boolean => (
  reviewRecordIsApproved(record)
  || ["rejected", "suppressed", "deleted", "dismissed"].includes(normalizedReviewValue(record.status))
  || ["rejected", "suppressed", "deleted", "dismissed"].includes(normalizedReviewValue(record.reviewStatus))
  || ["rejected", "suppressed", "deleted", "dismissed"].includes(normalizedReviewValue(record.queueState))
  || reviewRecordDecisionIsCurrent(record)
);

export const SUPPLIER_REVIEW_DECISION_METADATA_FIELDS = [
  "decisionAction",
  "decisionPendingRevision",
  "decisionCompletedAt",
  "decisionCompletedBy",
  "decisionAuditId",
  "decisionProductId",
  "systemDecision",
  "systemDecisionReason",
] as const;

/**
 * Field deletes for a requeue write that carries a new pending revision. The
 * previous decision metadata described an older observation; the immutable
 * supplier_approval_audit trail keeps the history. A decision made against the
 * incoming revision is left untouched.
 */
export const supplierReviewStaleDecisionFieldDeletes = (
  existing: Record<string, unknown> | null | undefined,
  nextPendingRevision: unknown,
): Record<string, FieldValue> => {
  const nextRevision = String(nextPendingRevision || "").trim();
  if (!existing || !nextRevision) return {};
  if (String(existing.decisionPendingRevision || "").trim() === nextRevision) return {};
  const present = SUPPLIER_REVIEW_DECISION_METADATA_FIELDS.filter((field) => Object.hasOwn(existing, field));
  return Object.fromEntries(present.map((field) => [field, FieldValue.delete()]));
};

export const reviewRecordIsActionable = (record: SupplierQueueRecord): boolean => (
  !reviewRecordIsTerminalDecision(record)
  && [
    "queued",
    "leased",
    "processing",
    "review_pending",
    "conflict",
    "retryable_failure",
    "dead_letter",
  ].includes(stateFor(record))
);

const reviewComparisonIsRemoval = (value: unknown): boolean => {
  const comparisonStatus = normalizedReviewValue(value);
  return comparisonStatus.includes("removed")
    || comparisonStatus.includes("deleted")
    || comparisonStatus.includes("deactivat");
};

const reviewComparisonHasPendingChange = (record: SupplierQueueRecord, comparisonStatus: string): boolean => {
  if (["price_changed", "stock_changed", "description_changed", "image_changed"].includes(comparisonStatus)) return true;
  const comparison = asRecord(record.comparison);
  return (Array.isArray(comparison.changedFields) && comparison.changedFields.length > 0)
    || (Array.isArray(comparison.fieldChanges) && comparison.fieldChanges.length > 0)
    || (Array.isArray(record.changedFields) && record.changedFields.length > 0)
    || (Array.isArray(record.fieldChanges) && record.fieldChanges.length > 0);
};

/**
 * Mirrors the Product Review business filters on the server pagination boundary.
 * Conflicts and removals keep precedence; any other active record that is on a
 * low-stock hold belongs only to low_stock_hold until its stock recovers.
 */
export const reviewRecordMatchesBusinessFilter = (
  record: SupplierQueueRecord,
  filter: SupplierReviewBusinessFilter,
  categoryRequirements?: SupplierReviewCategoryRequirements,
): boolean => {
  const projectedRecord = projectSupplierReviewLowStockHold(
    record,
    categoryRequirements?.get(supplierReviewCategoryId(record)) === true,
  );
  const comparisonStatus = normalizedReviewValue(
    asRecord(projectedRecord.comparison).comparisonStatus || projectedRecord.comparisonStatus,
  );
  if (filter === "approved_history") return reviewRecordIsTerminalDecision(projectedRecord);
  if (reviewRecordIsTerminalDecision(projectedRecord)) return false;
  if (filter === "conflicts") return reviewRecordIsConflict(projectedRecord);
  if (reviewRecordIsConflict(projectedRecord)) return false;
  if (filter === "removed_products") return reviewComparisonIsRemoval(comparisonStatus);
  if (reviewComparisonIsRemoval(comparisonStatus)) return false;
  const lowStockHold = supplierReviewRecordIsLowStockHold(projectedRecord);
  if (filter === "low_stock_hold") return lowStockHold;
  if (lowStockHold) return false;
  if (filter === "new_products") return comparisonStatus === "new_product";
  if (filter === "needs_attention") {
    const validation = asRecord(projectedRecord.productValidation);
    return validation.readyToPublish === false
      || (Array.isArray(validation.missingFields) && validation.missingFields.length > 0)
      || (Array.isArray(validation.errors) && validation.errors.length > 0)
      || ["failed", "partial"].includes(normalizedReviewValue(record.mediaStatus))
      || ["retryable_failure", "dead_letter"].includes(normalizedReviewValue(record.queueState));
  }
  return !reviewRecordIsApproved(projectedRecord)
    && !reviewRecordIsConflict(projectedRecord)
    && comparisonStatus !== "new_product"
    && !reviewComparisonIsRemoval(comparisonStatus)
    && reviewComparisonHasPendingChange(projectedRecord, comparisonStatus);
};

/**
 * Splits active review work for Product Review counts: a record on low-stock
 * hold is counted only as held, never also as actionable.
 */
export const classifySupplierReviewRecordForCounts = (
  record: SupplierQueueRecord,
): "actionable" | "low_stock_hold" | null => {
  if (!reviewRecordIsActionable(record)) return null;
  return reviewRecordMatchesBusinessFilter(record, "low_stock_hold") ? "low_stock_hold" : "actionable";
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
    sort?: SupplierReviewQueueSort;
    businessFilter?: SupplierReviewBusinessFilter;
    after?: string;
    limit?: number;
    snapshotBoundary?: string;
    mediaFilter?: SupplierReviewMediaFilter;
  },
): Promise<SupplierQueuePageResult> {
  const pageLimit = Number.isInteger(options.limit) ? Math.max(1, Math.min(100, Number(options.limit))) : 50;
  const state = options.view === "review" ? options.state || "active" : "active";
  const sort = options.view === "review" ? options.sort || "created" : "created";
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
  if (options.snapshotBoundary) {
    query = query.where(sort === "updated" ? "updatedAt" : "createdAt", "<=", options.snapshotBoundary);
  }
  query = query
    .orderBy(sort === "updated" ? "updatedAt" : "createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (options.after) {
    const cursor = await collection.doc(options.after).get();
    if (!cursor.exists) throw new Error("Supplier queue cursor is invalid.");
    query = query.startAfter(cursor);
  }

  let categoryRequirements: Map<string, boolean> | null = null;
  const ensureCategoryRequirements = async (records: SupplierQueueRecord[]): Promise<void> => {
    if (categoryRequirements || !records.some((record) => hasLegacySupplierDerivedReviewTaxonomy(record))) return;
    categoryRequirements = await loadSupplierReviewCategoryRequirements(db);
  };

  if (options.view === "review" && (options.businessFilter || (options.mediaFilter && options.mediaFilter !== "all"))) {
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

      const records = snapshot.docs.map((document) => document.data() as SupplierQueueRecord);
      await ensureCategoryRequirements(records);

      let pageFilledAt = -1;
      for (let index = 0; index < snapshot.docs.length; index += 1) {
        const document = snapshot.docs[index];
        const record = document.data() as SupplierQueueRecord;
        if (reviewRecordMatchesState(record, state as SupplierReviewQueuePageState)
          && (!options.businessFilter || reviewRecordMatchesBusinessFilter(record, options.businessFilter, categoryRequirements || undefined))
          && (!options.mediaFilter || options.mediaFilter === "all" || supplierReviewMediaMatchesFilter(record, options.mediaFilter))) {
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

    const rawDocuments = documents.map((document) => projectSupplierReviewLowStockHold(
      { id: document.id, ...document.data() },
      categoryRequirements?.get(supplierReviewCategoryId(document.data() as SupplierQueueRecord)) === true,
    ));
    return {
      view: options.view,
      state,
      items: await decorateSupplierReviewQueueAdminMedia(rawDocuments),
      nextCursor,
    };
  }

  const snapshot = await query.limit(scanLimit).get();
  await ensureCategoryRequirements(snapshot.docs.map((document) => document.data() as SupplierQueueRecord));
  const matched = snapshot.docs.filter((document) => options.view !== "review"
    || (reviewRecordMatchesState(document.data() as SupplierQueueRecord, state as SupplierReviewQueuePageState)
      && (!options.mediaFilter || options.mediaFilter === "all" || supplierReviewMediaMatchesFilter(document.data() as SupplierQueueRecord, options.mediaFilter))));
  const pageDocuments = matched.slice(0, pageLimit);
  const cursorDocument = pageDocuments.length === pageLimit
    ? pageDocuments.at(-1)
    : snapshot.size === scanLimit ? snapshot.docs.at(-1) : null;
   const rawDocuments = pageDocuments.map((document) => projectSupplierReviewLowStockHold(
    { id: document.id, ...document.data() },
    categoryRequirements?.get(supplierReviewCategoryId(document.data() as SupplierQueueRecord)) === true,
  ));
  return {
    view: options.view,
    state,
    items: await decorateSupplierReviewQueueAdminMedia(rawDocuments),
    nextCursor: cursorDocument?.id || null,
  };
}

const SUPPLIER_REVIEW_PAGE_REPLAY_LIMIT = 10;
const SUPPLIER_REVIEW_EXACT_SEARCH_MATCH_LIMIT = 100;
const SUPPLIER_REVIEW_EXACT_SEARCH_FIELDS = [
  "supplierProductId",
  "supplierItemCode",
  "supplierCode",
  "sku",
  "supplierOfferId",
  "supplierSkuClaimId",
  "productPayload.supplierProductId",
  "productPayload.supplierItemCode",
  "productPayload.sku",
  "supplierSnapshot.supplierProductId",
  "supplierSnapshot.supplierItemCode",
  "supplierSnapshot.sku",
] as const;

const reviewSortField = (sort: SupplierReviewQueueSort): "createdAt" | "updatedAt" => (
  sort === "updated" ? "updatedAt" : "createdAt"
);

const reviewCursorValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value && "toMillis" in value && typeof value.toMillis === "function") {
    return `timestamp:${String(value.toMillis())}`;
  }
  if (value instanceof Date) return `date:${value.toISOString()}`;
  return String(value);
};

export const buildSupplierReviewQueryFingerprint = (query: SupplierReviewQueryModel): string => {
  const normalized = {
    view: query.view,
    state: query.state,
    businessFilter: query.businessFilter || null,
    mediaFilter: query.mediaFilter,
    search: query.search.trim(),
    searchMode: query.searchMode,
    sort: query.sort,
    pageSize: query.pageSize,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32);
};

export const encodeSupplierReviewCursorToken = (token: SupplierReviewCursorToken): string => (
  Buffer.from(JSON.stringify(token), "utf8").toString("base64url")
);

export const decodeSupplierReviewCursorToken = (encoded: string): SupplierReviewCursorToken => {
  if (!encoded || encoded.length > 4096) throw new Error("Supplier review cursor is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Supplier review cursor is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Supplier review cursor is invalid.");
  }
  const token = parsed as Partial<SupplierReviewCursorToken>;
  if (token.version !== 1
    || !Number.isInteger(token.page) || Number(token.page) < 1
    || (token.anchorId !== null && typeof token.anchorId !== "string")
    || (token.previousToken !== null && typeof token.previousToken !== "string")
    || typeof token.fingerprint !== "string"
    || typeof token.queryRevision !== "string"
    || (token.sort !== "created" && token.sort !== "updated")
    || (token.sortValue !== null && typeof token.sortValue !== "string")) {
    throw new Error("Supplier review cursor is invalid.");
  }
  return token as SupplierReviewCursorToken;
};

const createSupplierReviewPageToken = (input: {
  page: number;
  anchorId: string | null;
  previousToken: string | null;
  fingerprint: string;
  queryRevision: string;
  sort: SupplierReviewQueueSort;
  sortValue: string | null;
}): string => encodeSupplierReviewCursorToken({ version: 1, ...input });

const boundedPreviousSupplierReviewToken = (token: SupplierReviewCursorToken): string | null => {
  const encoded = encodeSupplierReviewCursorToken(token);
  return encoded.length <= 1800 ? encoded : null;
};

const reviewPageQuery = (
  db: Firestore,
  query: SupplierReviewQueryModel,
  queryRevision: string,
  useIndexedMediaProjection = false,
): FirebaseFirestore.Query => {
  const collection = db.collection("supplier_review_queue");
  const statuses = reviewStatusValues(query.state);
  let result: FirebaseFirestore.Query = statuses.length === 1
    ? collection.where("status", "==", statuses[0])
    : collection.where("status", "in", statuses);
  if (useIndexedMediaProjection && query.mediaFilter !== "all") {
    const mediaQueueClass = query.mediaFilter === "ready"
      ? "ready"
      : query.mediaFilter === "processing" ? "processing" : "issues";
    result = result.where(SUPPLIER_MEDIA_QUEUE_CLASS_FIELD, "==", mediaQueueClass);
  }
  result = result.where(reviewSortField(query.sort), "<=", queryRevision);
  return result;
};

const reviewPageReadQuery = (
  db: Firestore,
  query: SupplierReviewQueryModel,
  queryRevision: string,
  useIndexedMediaProjection: boolean,
): FirebaseFirestore.Query => reviewPageQuery(db, query, queryRevision, useIndexedMediaProjection)
  .orderBy(reviewSortField(query.sort), "desc")
  .orderBy(FieldPath.documentId(), "desc");

const compareReviewDocuments = (
  left: FirebaseFirestore.QueryDocumentSnapshot,
  right: FirebaseFirestore.QueryDocumentSnapshot,
  sort: SupplierReviewQueueSort,
): number => {
  const field = reviewSortField(sort);
  const leftValue = reviewCursorValue(left.data()[field]);
  const rightValue = reviewCursorValue(right.data()[field]);
  const primary = String(rightValue || "").localeCompare(String(leftValue || ""));
  return primary || right.id.localeCompare(left.id);
};

const readExactSupplierReviewDocuments = async (
  db: Firestore,
  query: SupplierReviewQueryModel,
  queryRevision: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> => {
  if (!query.search) return [];
  const collection = db.collection("supplier_review_queue");
  const documents = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const field of SUPPLIER_REVIEW_EXACT_SEARCH_FIELDS) {
    const snapshot = await collection.where(field, "==", query.search).limit(SUPPLIER_REVIEW_EXACT_SEARCH_MATCH_LIMIT + 1).get();
    if (snapshot.size > SUPPLIER_REVIEW_EXACT_SEARCH_MATCH_LIMIT) {
      throw new Error("This exact search is too broad. Use a supplier SKU or product ID.");
    }
    snapshot.docs.forEach((document) => documents.set(document.id, document));
  }
  const categoryRequirements = query.businessFilter
    ? await loadSupplierReviewCategoryRequirements(db)
    : undefined;
  return Array.from(documents.values())
    .filter((document) => {
      const record = document.data() as SupplierQueueRecord;
      const sortValue = reviewCursorValue(record[reviewSortField(query.sort)]);
      return Boolean(sortValue && sortValue <= queryRevision)
        && reviewRecordMatchesState(record, query.state)
        && (!query.businessFilter || reviewRecordMatchesBusinessFilter(record, query.businessFilter, categoryRequirements))
        && supplierReviewMediaMatchesFilter(record, query.mediaFilter);
    })
    .sort((left, right) => compareReviewDocuments(left, right, query.sort));
};

const readExactSearchPage = async (
  db: Firestore,
  query: SupplierReviewQueryModel,
  queryRevision: string,
  anchorId: string | null,
): Promise<{ documents: FirebaseFirestore.QueryDocumentSnapshot[]; totalCount: number }> => {
  const documents = await readExactSupplierReviewDocuments(db, query, queryRevision);
  const anchorIndex = anchorId ? documents.findIndex((document) => document.id === anchorId) : -1;
  if (anchorId && anchorIndex < 0) throw new Error("Supplier review cursor is stale.");
  return {
    documents: documents.slice(anchorIndex + 1, anchorIndex + 1 + query.pageSize),
    totalCount: documents.length,
  };
};

const countSupplierReviewQuery = async (
  db: Firestore,
  query: SupplierReviewQueryModel,
  queryRevision: string,
  useIndexedMediaProjection = false,
): Promise<{ totalCount: number | null; countStatus: "exact" | "unavailable"; countReason?: string }> => {
  if (query.businessFilter || (query.mediaFilter !== "all" && !query.search && !useIndexedMediaProjection)) {
    return {
      totalCount: null,
      countStatus: "unavailable",
      countReason: query.businessFilter
        ? "This business filter includes derived review rules that are not represented by one countable Firestore predicate yet."
        : "This media filter is derived from per-item readiness evidence and has no single countable Firestore predicate yet.",
    };
  }
  if (query.search) {
    const documents = await readExactSupplierReviewDocuments(db, query, queryRevision);
    return { totalCount: documents.length, countStatus: "exact" };
  }
  const aggregate = await reviewPageQuery(db, query, queryRevision, useIndexedMediaProjection).count().get();
  return { totalCount: aggregate.data().count, countStatus: "exact" };
};

const projectReadModelDocuments = async (
  db: Firestore,
  documents: FirebaseFirestore.QueryDocumentSnapshot[],
  query: SupplierReviewQueryModel,
): Promise<Array<Record<string, unknown> & { id: string }>> => {
  let categoryRequirements: Map<string, boolean> | undefined;
  if (query.businessFilter && documents.length > 0) {
    categoryRequirements = await loadSupplierReviewCategoryRequirements(db);
  }
  const rawDocuments = documents.map((document) => projectSupplierReviewLowStockHold(
    { id: document.id, ...document.data() },
    categoryRequirements?.get(supplierReviewCategoryId(document.data() as SupplierQueueRecord)) === true,
  ));
  const decorated = await decorateSupplierReviewQueueAdminMedia(rawDocuments);
  return decorated.map((item, index) => ({
    ...item,
    media: classifySupplierMediaObservability(documents[index]?.data() || {}),
  }));
};

const emptySupplierReviewMediaSummary = (reason: string): SupplierReviewMediaSummary => ({
  countStatus: "unavailable",
  counts: {
    ready: null,
    processing: null,
    retryScheduled: null,
    needsAttention: null,
    supplierImageUnavailable: null,
    permanentMediaIssue: null,
    legacyUnknown: null,
  },
  oldestProcessingAgeSeconds: null,
  possiblyStuckCount: null,
  unavailableReasons: [reason],
});

const countQueueState = async (db: Firestore, queueState: string): Promise<number> => (
  (await db.collection("supplier_review_queue").where("queueState", "==", queueState).count().get()).data().count
);

const loadSupplierReviewMediaSummary = async (
  db: Firestore,
  query: SupplierReviewQueryModel,
): Promise<SupplierReviewMediaSummary> => {
  if (query.businessFilter || query.search || query.mediaFilter !== "all" || query.state !== "active") {
    return emptySupplierReviewMediaSummary("Media summary is only aggregated for the unfiltered active review population.");
  }
  const [queued, leased, processing, retryScheduled] = await Promise.all([
    countQueueState(db, "queued"),
    countQueueState(db, "leased"),
    countQueueState(db, "processing"),
    countQueueState(db, "retryable_failure"),
  ]);
  return {
    countStatus: "partial",
    counts: {
      ready: null,
      processing: queued + leased + processing,
      retryScheduled,
      needsAttention: null,
      supplierImageUnavailable: null,
      permanentMediaIssue: null,
      legacyUnknown: null,
    },
    oldestProcessingAgeSeconds: null,
    possiblyStuckCount: null,
    unavailableReasons: [
      "Ready, issue, legacy, and stuck counts require per-item media evidence and are not estimated from queue-state counts.",
    ],
  };
};

export async function listSupplierReviewReadModelPage(
  db: Firestore,
  options: {
    query: SupplierReviewQueryModel;
    page?: number;
    cursor?: string;
    queryRevision?: string;
  },
): Promise<SupplierReviewReadModelPage> {
  const query = options.query;
  const fingerprint = buildSupplierReviewQueryFingerprint(query);
  const decodedCursor = options.cursor ? decodeSupplierReviewCursorToken(options.cursor) : null;
  if (decodedCursor && decodedCursor.fingerprint !== fingerprint) throw new Error("Supplier review cursor does not match this query.");
  if (decodedCursor && decodedCursor.sort !== query.sort) throw new Error("Supplier review cursor does not match this sort.");
  if (decodedCursor && decodedCursor.queryRevision !== (options.queryRevision || decodedCursor.queryRevision)) {
    throw new Error("Supplier review cursor does not match this query revision.");
  }
  const targetPage = options.page || decodedCursor?.page || 1;
  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > 10_000) throw new Error("Supplier review page is invalid.");
  if (!decodedCursor && targetPage > 1) throw new Error("A valid page anchor is required for this page.");
  const queryRevision = options.queryRevision || decodedCursor?.queryRevision || new Date().toISOString();
  if (decodedCursor?.anchorId) {
    const anchor = await db.collection("supplier_review_queue").doc(decodedCursor.anchorId).get();
    if (!anchor.exists || reviewCursorValue(anchor.data()?.[reviewSortField(query.sort)]) !== decodedCursor.sortValue) {
      throw new Error("Supplier review cursor is stale.");
    }
  }
  const replayStartPage = decodedCursor?.page || 1;
  if (targetPage < replayStartPage) throw new Error("The requested page precedes the supplied cursor.");
  if (targetPage - replayStartPage > SUPPLIER_REVIEW_PAGE_REPLAY_LIMIT) {
    throw new Error("The requested page jump is too large for the available cursor anchor.");
  }

  const useIndexedMediaProjection = !query.businessFilter
    && !query.search
    && query.mediaFilter !== "all"
    && query.state !== "history"
    && await isSupplierMediaQueueProjectionActive(db);
  const count = await countSupplierReviewQuery(db, query, queryRevision, useIndexedMediaProjection);
  const generatedAt = new Date().toISOString();
  let currentToken = decodedCursor || decodeSupplierReviewCursorToken(createSupplierReviewPageToken({
    page: 1,
    anchorId: null,
    previousToken: null,
    fingerprint,
    queryRevision,
    sort: query.sort,
    sortValue: null,
  }));
  let resultDocuments: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let resultNextAnchorId: string | null = null;
  let totalCount = count.totalCount;
  for (let page = replayStartPage; page <= targetPage; page += 1) {
    if (query.search) {
      const result = await readExactSearchPage(db, query, queryRevision, currentToken.anchorId);
      resultDocuments = result.documents;
      totalCount = result.totalCount;
      resultNextAnchorId = result.documents.length === query.pageSize
        ? result.documents.at(-1)?.id || null
        : null;
      if (page < targetPage) {
        if (!resultNextAnchorId) throw new Error("The requested page does not exist.");
        const nextDocument = await db.collection("supplier_review_queue").doc(resultNextAnchorId).get();
        if (!nextDocument.exists) throw new Error("Supplier review cursor is stale.");
        currentToken = decodeSupplierReviewCursorToken(createSupplierReviewPageToken({
          page: page + 1,
          anchorId: resultNextAnchorId,
          previousToken: boundedPreviousSupplierReviewToken(currentToken),
          fingerprint,
          queryRevision,
          sort: query.sort,
          sortValue: reviewCursorValue(nextDocument.data()?.[reviewSortField(query.sort)]),
        }));
      }
    } else if (useIndexedMediaProjection) {
      let indexedQuery = reviewPageReadQuery(db, query, queryRevision, true);
      if (currentToken.anchorId) {
        const anchor = await db.collection("supplier_review_queue").doc(currentToken.anchorId).get();
        if (!anchor.exists) throw new Error("Supplier review cursor is stale.");
        indexedQuery = indexedQuery.startAfter(anchor);
      }
      const snapshot = await indexedQuery.limit(query.pageSize).get();
      resultDocuments = snapshot.docs;
      resultNextAnchorId = snapshot.size === query.pageSize
        ? snapshot.docs.at(-1)?.id || null
        : null;
      if (page < targetPage) {
        if (!resultNextAnchorId) throw new Error("The requested page does not exist.");
        const nextDocument = await db.collection("supplier_review_queue").doc(resultNextAnchorId).get();
        if (!nextDocument.exists) throw new Error("Supplier review cursor is stale.");
        currentToken = decodeSupplierReviewCursorToken(createSupplierReviewPageToken({
          page: page + 1,
          anchorId: resultNextAnchorId,
          previousToken: boundedPreviousSupplierReviewToken(currentToken),
          fingerprint,
          queryRevision,
          sort: query.sort,
          sortValue: reviewCursorValue(nextDocument.data()?.[reviewSortField(query.sort)]),
        }));
      }
    } else {
      const legacyPage = await listSupplierQueuePage(db, {
        view: "review",
        state: query.state,
        sort: query.sort,
        businessFilter: query.businessFilter,
        mediaFilter: query.mediaFilter,
        after: currentToken.anchorId || undefined,
        limit: query.pageSize,
        snapshotBoundary: queryRevision,
      });
      const documentIds = legacyPage.items.map((item) => item.id);
      const documents = await Promise.all(documentIds.map(async (id) => db.collection("supplier_review_queue").doc(id).get()));
      resultDocuments = documents.filter((document): document is FirebaseFirestore.QueryDocumentSnapshot => document.exists);
      resultNextAnchorId = legacyPage.nextCursor;
      if (page < targetPage) {
        const nextId = legacyPage.nextCursor;
        if (!nextId) throw new Error("The requested page does not exist.");
        const nextDocument = await db.collection("supplier_review_queue").doc(nextId).get();
        if (!nextDocument.exists) throw new Error("Supplier review cursor is stale.");
        currentToken = decodeSupplierReviewCursorToken(createSupplierReviewPageToken({
          page: page + 1,
          anchorId: nextId,
          previousToken: boundedPreviousSupplierReviewToken(currentToken),
          fingerprint,
          queryRevision,
          sort: query.sort,
          sortValue: reviewCursorValue(nextDocument.data()?.[reviewSortField(query.sort)]),
        }));
      }
    }
  }

  const items = query.search
    ? await projectReadModelDocuments(db, resultDocuments, query)
    : await projectReadModelDocuments(db, resultDocuments, query);
  const mediaSummary = await loadSupplierReviewMediaSummary(db, query);
  const nextAnchorDocument = resultNextAnchorId
    ? await db.collection("supplier_review_queue").doc(resultNextAnchorId).get()
    : null;
  const hasNext = totalCount === null
    ? Boolean(resultNextAnchorId)
    : targetPage * query.pageSize < totalCount;
  const nextToken = hasNext && nextAnchorDocument?.exists
    ? createSupplierReviewPageToken({
      page: targetPage + 1,
      anchorId: nextAnchorDocument.id,
      previousToken: boundedPreviousSupplierReviewToken(currentToken),
      fingerprint,
      queryRevision,
      sort: query.sort,
      sortValue: reviewCursorValue(nextAnchorDocument.data()?.[reviewSortField(query.sort)]),
    })
    : null;
  return {
    view: query.view,
    state: query.state,
    items,
    page: targetPage,
    pageSize: query.pageSize,
    totalCount,
    totalPages: totalCount === null ? null : Math.max(1, Math.ceil(totalCount / query.pageSize)),
    countStatus: count.countStatus,
    ...(count.countReason ? { countReason: count.countReason } : {}),
    nextCursor: nextToken,
    previousCursor: currentToken.page > 1 ? currentToken.previousToken : null,
    queryFingerprint: fingerprint,
    queryRevision,
    generatedAt,
    searchCapabilities: { exactSupplierIdentity: true, productNamePrefix: false },
    mediaSummary,
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
