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
import { recordSupplierQueueProcessingDurationMetric } from "../api/suppliers/supplierCloudMonitoring";
import { appLogger } from "../api/logging";
import {
  normalizeSupplierMappingValue,
  isExplicitSupplierChildMapping,
  selectSupplierCategoryMapping,
  supplierChildMappingDocumentId,
  supplierMappingDocumentId,
  supplierSubcategoryMatchesMapping,
  isCanonicalActiveCategory,
  SupplierCategoryMappingRecord,
} from "../api/suppliers/supplierProductMapping";

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
  mediaSourceImageUrls?: unknown;
}

const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const hasAdminTaxonomyOwnership = (payload: Record<string, unknown>): boolean => {
  const ownership = asRecord(payload.supplierFieldOwnership);
  return ["category", "subcategory"].some((field) => {
    const entry = ownership[field];
    return entry === "admin" || asString(asRecord(entry).owner) === "admin";
  });
};

export const projectSupplierReviewTaxonomy = (
  record: Record<string, unknown> & { id: string },
  selection: { mapping: SupplierCategoryMappingRecord; scope: "source" | "global" },
  category: Record<string, unknown>,
  supplierCategory: string,
  supplierSubcategory: string,
  targetCategoryId: string,
  targetSubcategoryId: string,
): Record<string, unknown> & { id: string } => {
  if (!isCanonicalActiveCategory(category)) return record;
  const payload = asRecord(record.productPayload);
  if (hasAdminTaxonomyOwnership(payload)) return record;
  const activeSubcategories = Array.isArray(category.subcategories)
    ? category.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object") && (entry as Record<string, unknown>).isActive !== false)
    : [];
  return {
    ...record,
    categoryMapping: {
      ...asRecord(record.categoryMapping),
      supplierCategory,
      supplierSubcategory,
      targetCategoryId,
      targetSubcategoryId,
      confidence: 100,
      mappingType: asString(selection.mapping.mappingType) || "manual",
      mappingSource: selection.scope,
      autoSelected: true,
      requiresManualSelection: activeSubcategories.length > 0 && !targetSubcategoryId,
    },
    productPayload: {
      ...payload,
      category: targetCategoryId,
      subcategory: targetSubcategoryId,
    },
  };
};

const applyTrustedCategoryMappingsForReview = async (
  db: Firestore,
  records: Array<Record<string, unknown> & { id: string }>,
): Promise<Array<Record<string, unknown> & { id: string }>> => {
  const mappingKeys = new Map<string, {
    sourceId: string;
    supplierCategory: string;
    supplierSubcategory: string;
    supplierSubcategoryId: string;
  }>();
  for (const record of records) {
    const snapshot = asRecord(record.supplierSnapshot);
    const hierarchy = Array.isArray(snapshot.categoryHierarchy) ? snapshot.categoryHierarchy : [];
    const sourceId = asString(record.sourceId) || asString(snapshot.sourceId);
    const supplierCategory = asString(hierarchy[0]);
    const supplierSubcategory = asString(hierarchy[1]);
    const supplierSubcategoryId = asString(record.supplierSubcategoryId)
      || asString(snapshot.supplierSubcategoryId)
      || asString(asRecord(snapshot.extraAttributes).supplierSubcategoryId);
    const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
    const childBinding = supplierChildMappingDocumentId(sourceId, normalizedCategory, supplierSubcategory, supplierSubcategoryId);
    if (sourceId && normalizedCategory) {
      mappingKeys.set(`${sourceId}\u0000${normalizedCategory}\u0000${childBinding || "parent"}`, {
        sourceId,
        supplierCategory,
        supplierSubcategory,
        supplierSubcategoryId,
      });
    }
  }
  if (mappingKeys.size === 0) return records;
  const mappingEntries = [...mappingKeys.entries()];
  const mappingSnapshots = await Promise.all(mappingEntries.map(async ([, value]) => {
    const collection = db.collection("supplier_category_mappings");
    const parentSnapshot = await collection.doc(supplierMappingDocumentId(value.sourceId, normalizeSupplierMappingValue(value.supplierCategory))).get();
    const childId = supplierChildMappingDocumentId(
      value.sourceId,
      normalizeSupplierMappingValue(value.supplierCategory),
      value.supplierSubcategory,
      value.supplierSubcategoryId,
    );
    const childSnapshot = childId ? await collection.doc(childId).get() : null;
    return { parentSnapshot, childSnapshot };
  }));
  const categoryIds = [...new Set(mappingSnapshots.flatMap(({ parentSnapshot, childSnapshot }) => [
    asString(parentSnapshot.data()?.targetCategoryId),
    asString(childSnapshot?.data()?.targetCategoryId),
  ]).filter(Boolean))];
  const categorySnapshots = await Promise.all(categoryIds.map((id) => db.collection("categories").doc(id).get()));
  const categories = new Map(categorySnapshots.map((snapshot) => [snapshot.id, snapshot.exists ? snapshot.data() || {} : null]));
  const mappings = new Map(mappingEntries.map(([key], index) => {
    const { parentSnapshot, childSnapshot } = mappingSnapshots[index];
    return [key, [
      ...(parentSnapshot.exists ? [parentSnapshot.data() as SupplierCategoryMappingRecord] : []),
      ...(childSnapshot?.exists ? [childSnapshot.data() as SupplierCategoryMappingRecord] : []),
    ]];
  }));
  return records.map((record) => {
    const snapshot = asRecord(record.supplierSnapshot);
    const hierarchy = Array.isArray(snapshot.categoryHierarchy) ? snapshot.categoryHierarchy : [];
    const sourceId = asString(record.sourceId) || asString(snapshot.sourceId);
    const supplierCategory = asString(hierarchy[0]);
    const supplierSubcategory = asString(hierarchy[1]);
    const supplierSubcategoryId = asString(record.supplierSubcategoryId)
      || asString(snapshot.supplierSubcategoryId)
      || asString(asRecord(snapshot.extraAttributes).supplierSubcategoryId);
    const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
    const childBinding = supplierChildMappingDocumentId(sourceId, normalizedCategory, supplierSubcategory, supplierSubcategoryId);
    const mappingCandidates = mappings.get(`${sourceId}\u0000${normalizedCategory}\u0000${childBinding || "parent"}`) || [];
    const selection = selectSupplierCategoryMapping({
      sourceId,
      normalizedCategory,
      supplierSubcategory,
      supplierSubcategoryId,
      mappings: mappingCandidates,
    });
    if (!selection) return record;
    const mapping = selection.mapping;
    const targetCategoryId = asString(mapping.targetCategoryId);
    const targetSubcategoryId = isExplicitSupplierChildMapping(mapping)
      && supplierSubcategoryMatchesMapping(
        mapping as SupplierCategoryMappingRecord,
        supplierSubcategory,
        supplierSubcategoryId,
      ) ? asString(mapping.targetSubcategoryId) : "";
    const category = categories.get(targetCategoryId);
    if (!category || !isCanonicalActiveCategory(category)) return record;
    const activeSubcategories = Array.isArray(category.subcategories)
      ? category.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object") && (entry as Record<string, unknown>).isActive !== false)
      : [];
    if (targetSubcategoryId && !activeSubcategories.some((entry) => String(entry.id || "") === targetSubcategoryId)) return record;
    return projectSupplierReviewTaxonomy(
      record,
      selection,
      category,
      supplierCategory,
      supplierSubcategory,
      targetCategoryId,
      targetSubcategoryId,
    );
  });
};

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
      await reference.set({
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
  await reference.set(patch, { merge: true });
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

export function buildSupplierQueueLifecycle(createdAt = new Date().toISOString()): Record<string, unknown> {
  return {
    queueState: "queued" satisfies SupplierQueueState,
    retryCount: 0,
    retryLimit: DEFAULT_RETRY_LIMIT,
    nextRetryAt: createdAt,
    queueCreatedAt: createdAt,
  };
}

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
    if (!record || supplierReviewQueueDecisionStates().has(stateFor(record))) {
      throw new Error("Supplier queue item is no longer processable.");
    }
    if (stateFor(record) !== "leased" || asString(record.leaseOwner) !== workerId || isSupplierQueueLeaseExpired(record, now)) {
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
    transaction.set(reference, {
      ...failure.data,
      ...(nextValidation ? { productValidation: nextValidation } : {}),
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
export type SupplierReviewQueueSort = "created" | "updated";
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

export const reviewRecordIsTerminalDecision = (record: SupplierQueueRecord): boolean => (
  reviewRecordIsApproved(record)
  || ["rejected", "suppressed", "deleted", "dismissed"].includes(normalizedReviewValue(record.status))
  || ["rejected", "suppressed", "deleted", "dismissed"].includes(normalizedReviewValue(record.reviewStatus))
  || ["rejected", "suppressed", "deleted", "dismissed"].includes(normalizedReviewValue(record.queueState))
  || ["approved", "rejected", "deleted", "dismissed", "suppressed"].includes(normalizedReviewValue(record.decisionAction))
);

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

/** Mirrors the Product Review business filters on the server pagination boundary. */
export const reviewRecordMatchesBusinessFilter = (
  record: SupplierQueueRecord,
  filter: SupplierReviewBusinessFilter,
): boolean => {
  const comparisonStatus = normalizedReviewValue(
    asRecord(record.comparison).comparisonStatus || record.comparisonStatus,
  );
  if (filter === "approved_history") return reviewRecordIsTerminalDecision(record);
  if (reviewRecordIsTerminalDecision(record)) return false;
  if (filter === "conflicts") return reviewRecordIsConflict(record);
  if (reviewRecordIsConflict(record)) return false;
  if (filter === "removed_products") return reviewComparisonIsRemoval(comparisonStatus);
  if (reviewComparisonIsRemoval(comparisonStatus)) return false;
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
    && !reviewComparisonIsRemoval(comparisonStatus)
    && reviewComparisonHasPendingChange(record, comparisonStatus);
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
  query = query
    .orderBy(sort === "updated" ? "updatedAt" : "createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
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

    const rawDocuments = documents.map((document) => ({ id: document.id, ...document.data() }));
    const mappedDocuments = options.view === "review"
      ? await applyTrustedCategoryMappingsForReview(db, rawDocuments)
      : rawDocuments;
    return {
      view: options.view,
      state,
      items: await decorateSupplierReviewQueueAdminMedia(mappedDocuments),
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
  const rawDocuments = pageDocuments.map((document) => ({ id: document.id, ...document.data() }));
  const mappedDocuments = options.view === "review"
    ? await applyTrustedCategoryMappingsForReview(db, rawDocuments)
    : rawDocuments;
  return {
    view: options.view,
    state,
    items: await decorateSupplierReviewQueueAdminMedia(mappedDocuments),
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
