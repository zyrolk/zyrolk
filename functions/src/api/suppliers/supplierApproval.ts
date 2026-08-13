import { FieldValue, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { COMMERCIAL_PRODUCT_FIELDS, PRODUCT_PRIVATE_COLLECTION, splitProductData } from "../products/productCommercialData";
import { isValidSupplierImageUrl } from "./a2z/ProductParser";
import {
  extractSupplierMediaFromRecord,
  SUPPLIER_MEDIA_COLLECTION,
  toPublishedProductMedia,
} from "./supplierMediaPipeline";
import { createSupplierAuditEvent } from "./supplierAuditTrail";
import {
  normalizeSupplierMappingValue,
  supplierMappingDocumentId,
  validateSupplierProductForApproval,
} from "./supplierProductMapping";
import {
  buildSupplierProductApprovalBaseline,
  detectSupplierApprovalConflict,
  parseSupplierProductApprovalBaseline,
  rebaseSupplierApprovalConflict,
  reconcileSupplierApprovalStock,
  SupplierApprovalConflict,
} from "./supplierApprovalConcurrency";
import { ensureSupplierReviewQueueManagedMedia } from "../../scheduled/supplierReviewQueue";
import {
  applySupplierProductFieldOwnership,
  parseSupplierProductEditedFields,
  parseSupplierProductFieldOwnershipDecision,
  SupplierProductFieldOwnershipDecision,
} from "./supplierFieldOwnership";
import {
  buildSupplierRemovalPublicProjection,
  isSupplierOfferAvailableForCommerce,
  parseSupplierOfferSelection,
  promoteSupplierOfferPendingObservation,
  projectSupplierOfferForAdmin,
  resolveActiveSupplierOffer,
  SupplierProductOffer,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "./supplierOfferEngine";
import {
  buildSupplierQueueIdentityProjection,
  resolveSupplierQueueIdentity,
} from "./supplierQueueIdentity";
import {
  assertZyroBarcodeAvailable,
  buildZyroProductId,
  buildZyroSkuCandidates,
  reserveZyroSku,
} from "./supplierProductIdentity";

// Every decision transaction appends an immutable supplier_approval_audit event
// through the shared server-only audit trail helper.

export interface SupplierApprovalDraft {
  productName: string;
  shortDescription?: string;
  description?: string;
  model?: string;
  barcode?: string;
  productType?: string;
  tags?: string[];
  keyFeatures?: string[];
  whatsIncluded?: string[];
  slug?: string;
  metaDescription?: string;
  keywords?: string[];
  sellingPrice: number;
  comparePrice: number;
  costPrice?: number;
  marketPrice?: number;
  stock: number;
  category: string;
  subcategory?: string;
  brand: string;
  specifications?: Record<string, string>;
  isActive: boolean;
  isNew?: boolean;
  isFeatured?: boolean;
  isBestSeller?: boolean;
  primaryImageUrl: string;
  galleryImageUrls: string[];
  fieldOwnership?: SupplierProductFieldOwnershipDecision;
  editedFields?: string[];
}

export interface SupplierAdminReviewer {
  uid: string;
  email: string;
}

export type SupplierQueueDecisionAction = "approved" | "rejected" | "deleted";

export interface SupplierQueueDecisionSuccessResult {
  success: true;
  queueItemId: string;
  action: SupplierQueueDecisionAction;
  status: "approved" | "rejected" | "deleted";
  productId?: string;
  sku?: string;
  idempotent?: boolean;
}

export interface SupplierQueueDecisionConflictResult {
  success: false;
  error: string;
  queueItemId: string;
  action: "approved";
  status: "conflict";
  conflict: SupplierApprovalConflict;
}

export type SupplierQueueDecisionResult = SupplierQueueDecisionSuccessResult | SupplierQueueDecisionConflictResult;

export interface SupplierApprovalIdentityDependencies {
  buildSkuCandidates?: (productId: string) => readonly string[];
}

interface QueueItemRecord extends Record<string, unknown> {
  id?: unknown;
  status?: unknown;
  reviewQueueItemId?: unknown;
  productPayload?: unknown;
  supplierSnapshot?: unknown;
  portalRequestId?: unknown;
  supplierId?: unknown;
  supplierSkuClaimId?: unknown;
  productFingerprintClaimId?: unknown;
  productName?: unknown;
  sourceId?: unknown;
  batchId?: unknown;
  approvalBaseline?: unknown;
  managedMedia?: unknown;
  supplierOfferPendingRevision?: unknown;
}

const MAX_QUEUE_ID_LENGTH = 160;
const MAX_REJECTION_REASON_LENGTH = 1_000;
const MAX_GALLERY_IMAGES = 20;

const cleanQueueItemId = (value: unknown): string => {
  if (typeof value !== "string") throw new ApiError("A supplier review queue item ID is required.", 400);
  const id = value.trim();
  if (!id || id.length > MAX_QUEUE_ID_LENGTH || id.includes("/")) {
    throw new ApiError("The supplier review queue item ID is invalid.", 400);
  }
  return id;
};

const cleanText = (value: unknown, field: string, maxLength: number, required = true): string => {
  if (typeof value !== "string") {
    throw new ApiError(`${field} must be text.`, 400);
  }
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > maxLength) {
    throw new ApiError(required ? `${field} is required.` : `${field} is invalid.`, 400);
  }
  return cleaned;
};

const cleanNumber = (value: unknown, field: string, options: { integer?: boolean; minimum: number }): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < options.minimum || (options.integer && !Number.isInteger(value))) {
    throw new ApiError(`${field} is invalid.`, 400);
  }
  return value;
};

const normalizeImages = (primaryImageUrl: string, galleryImageUrls: readonly string[]): string[] => {
  const images = [primaryImageUrl, ...galleryImageUrls]
    .filter((imageUrl) => isValidSupplierImageUrl(imageUrl))
    .map((imageUrl) => imageUrl.trim());
  return [...new Set(images)];
};

const cleanSpecifications = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw new ApiError("Product specifications are invalid.", 400);
  return Object.fromEntries(entries.map(([key, entry]) => [
    cleanText(key, "Specification name", 100),
    cleanText(entry, `Specification ${key}`, 500, false),
  ]));
};

const cleanTextList = (value: unknown, field: string, maximum = 40): string[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new ApiError(`${field} is invalid.`, 400);
  return [...new Set(value.map((entry) => cleanText(entry, field, 240, false)).filter(Boolean))];
};

const cleanOptionalText = (value: unknown, field: string, maximum: number): string => value === undefined
  ? ""
  : cleanText(value, field, maximum, false);

export function parseSupplierApprovalDraft(value: unknown): SupplierApprovalDraft | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Review draft must be an object.", 400);
  }
  const draft = value as Record<string, unknown>;
  const productName = cleanText(draft.productName, "Product name", 300);
  const shortDescription = cleanOptionalText(draft.shortDescription, "Short description", 500);
  const description = cleanOptionalText(draft.description, "Description", 20_000);
  const model = cleanOptionalText(draft.model, "Model", 160);
  const barcode = cleanOptionalText(draft.barcode, "Barcode", 64);
  const productType = cleanOptionalText(draft.productType, "Product type", 160);
  const slug = cleanOptionalText(draft.slug, "SEO slug", 160);
  const metaDescription = cleanOptionalText(draft.metaDescription, "Meta description", 500);
  const category = cleanText(draft.category, "Category", 160);
  const subcategory = typeof draft.subcategory === "string" ? cleanText(draft.subcategory, "Subcategory", 160, false) : undefined;
  const specifications = draft.specifications === undefined ? undefined : cleanSpecifications(draft.specifications);
  const brand = cleanText(draft.brand, "Brand", 160, false);
  const primaryImageUrl = cleanText(draft.primaryImageUrl, "Primary image URL", 2_000);
  if (!isValidSupplierImageUrl(primaryImageUrl)) {
    throw new ApiError("A valid supplier product image is required before publishing.", 400);
  }
  if (!Array.isArray(draft.galleryImageUrls) || draft.galleryImageUrls.length > MAX_GALLERY_IMAGES) {
    throw new ApiError("Gallery images are invalid.", 400);
  }
  const galleryImageUrls = draft.galleryImageUrls.map((imageUrl) => cleanText(imageUrl, "Gallery image URL", 2_000));
  if (galleryImageUrls.some((imageUrl) => !isValidSupplierImageUrl(imageUrl))) {
    throw new ApiError("Every gallery image must use a valid supplier image URL.", 400);
  }
  if (typeof draft.isActive !== "boolean") throw new ApiError("Product visibility is invalid.", 400);
  if ((draft.isNew !== undefined && typeof draft.isNew !== "boolean")
    || (draft.isFeatured !== undefined && typeof draft.isFeatured !== "boolean")
    || (draft.isBestSeller !== undefined && typeof draft.isBestSeller !== "boolean")) {
    throw new ApiError("Product merchandising flags are invalid.", 400);
  }

  const sellingPrice = cleanNumber(draft.sellingPrice, "Selling price", { minimum: Number.EPSILON });
  const comparePrice = cleanNumber(draft.comparePrice, "Compare price", { minimum: 0 });
  const costPrice = draft.costPrice === undefined ? undefined : cleanNumber(draft.costPrice, "Cost price", { minimum: 0 });
  const marketPrice = draft.marketPrice === undefined ? undefined : cleanNumber(draft.marketPrice, "Market price", { minimum: 0 });
  if (comparePrice > 0 && comparePrice < sellingPrice) {
    throw new ApiError("Compare price must be at least the selling price.", 400);
  }

  return {
    productName,
    ...(draft.shortDescription !== undefined ? { shortDescription } : {}),
    ...(draft.description !== undefined ? { description } : {}),
    ...(draft.model !== undefined ? { model } : {}),
    ...(draft.barcode !== undefined ? { barcode } : {}),
    ...(draft.productType !== undefined ? { productType } : {}),
    ...(draft.tags !== undefined ? { tags: cleanTextList(draft.tags, "Product tags") } : {}),
    ...(draft.keyFeatures !== undefined ? { keyFeatures: cleanTextList(draft.keyFeatures, "Key features") } : {}),
    ...(draft.whatsIncluded !== undefined ? { whatsIncluded: cleanTextList(draft.whatsIncluded, "What's included") } : {}),
    ...(draft.slug !== undefined ? { slug } : {}),
    ...(draft.metaDescription !== undefined ? { metaDescription } : {}),
    ...(draft.keywords !== undefined ? { keywords: cleanTextList(draft.keywords, "SEO keywords") } : {}),
    sellingPrice,
    comparePrice,
    ...(costPrice !== undefined ? { costPrice } : {}),
    ...(marketPrice !== undefined ? { marketPrice } : {}),
    stock: cleanNumber(draft.stock, "Stock", { integer: true, minimum: 0 }),
    category,
    ...(subcategory !== undefined ? { subcategory } : {}),
    brand,
    ...(specifications !== undefined ? { specifications } : {}),
    isActive: draft.isActive,
    ...(draft.isNew !== undefined ? { isNew: draft.isNew === true } : {}),
    ...(draft.isFeatured !== undefined ? { isFeatured: draft.isFeatured === true } : {}),
    ...(draft.isBestSeller !== undefined ? { isBestSeller: draft.isBestSeller === true } : {}),
    primaryImageUrl,
    galleryImageUrls,
    ...(draft.fieldOwnership !== undefined ? { fieldOwnership: (() => {
      try {
        return parseSupplierProductFieldOwnershipDecision(draft.fieldOwnership);
      } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : "Product field ownership is invalid.", 400);
      }
    })() } : {}),
    ...(draft.editedFields !== undefined ? { editedFields: (() => {
      try {
        return parseSupplierProductEditedFields(draft.editedFields);
      } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : "Edited product fields are invalid.", 400);
      }
    })() } : {}),
  };
}

export function parseSupplierReviewQueueItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ApiError("Select between one and 100 supplier review items.", 400);
  }
  const ids = value.map(cleanQueueItemId);
  if (new Set(ids).size !== ids.length) throw new ApiError("Supplier review item IDs must be unique.", 400);
  return ids;
}

const queueIdFor = (queueItemId: string): string => queueItemId.startsWith("change-")
  ? queueItemId.slice("change-".length)
  : queueItemId;

const isPending = (value: unknown): boolean => String(value || "").toLowerCase() === "pending";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const supplierReviewAllowsDismissal = (queueItem: QueueItemRecord): boolean => {
  const queueState = String(queueItem.queueState || "").trim().toLowerCase();
  const status = String(queueItem.status || "").trim().toLowerCase();
  const validation = record(queueItem.productValidation);
  const missingFields = Array.isArray(validation.missingFields) ? validation.missingFields : [];
  const validationErrors = Array.isArray(validation.errors) ? validation.errors : [];
  const mediaStatus = String(queueItem.mediaStatus || "").trim().toLowerCase();

  return queueState === "conflict"
    || status === "conflict"
    || validation.readyToPublish === false
    || missingFields.length > 0
    || validationErrors.length > 0
    || mediaStatus === "failed"
    || mediaStatus === "partial";
};

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const cleanPendingRevision = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value.trim())) {
    throw new ApiError("The supplier observation revision is invalid.", 400);
  }
  return value.trim();
};

export function buildAutoProductSku(productId: string): string {
  return buildZyroSkuCandidates(cleanText(productId, "Product ID", 160))[0];
}

const normalizeSupplierCategory = (value: unknown): string => String(value || "")
  .normalize("NFKC")
  .trim()
  .toLocaleLowerCase("en")
  .replace(/[\s_-]+/g, " ");

const toPublicProductPayload = (queueItem: QueueItemRecord, draft: SupplierApprovalDraft | undefined): Record<string, unknown> => {
  const originalPayload = record(queueItem.productPayload);
  const productId = cleanText(originalPayload.id, "Product payload ID", 160);
  const fallbackPrimaryImage = stringValue(originalPayload.imageUrl);
  const fallbackGallery = Array.isArray(originalPayload.imageUrls)
    ? originalPayload.imageUrls.filter((imageUrl): imageUrl is string => typeof imageUrl === "string")
    : [];
  const managedMedia = extractSupplierMediaFromRecord(queueItem.managedMedia || record(queueItem.supplierSnapshot).managedMedia);
  const managedUrls = managedMedia.map((asset) => asset.firebaseStorageUrl);
  const primaryImageUrl = draft?.primaryImageUrl || managedUrls[0] || fallbackPrimaryImage;
  const galleryImageUrls = draft?.galleryImageUrls || (managedUrls.length > 0 ? managedUrls.slice(1) : fallbackGallery);
  const images = normalizeImages(primaryImageUrl, galleryImageUrls);
  if (!managedMedia.length || !images.length || images[0] !== primaryImageUrl || images.some((image) => !managedUrls.includes(image))) {
    throw new ApiError("A valid managed product image is required before publishing.", 422);
  }
  const price = draft?.sellingPrice ?? Number(originalPayload.price);
  const comparePrice = draft?.comparePrice ?? Number(originalPayload.originalPrice ?? originalPayload.price);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(comparePrice) || comparePrice < 0 || (comparePrice > 0 && comparePrice < price)) {
    throw new ApiError("Supplier product pricing is invalid.", 422);
  }
  const stock = draft?.stock ?? Number(originalPayload.stock);
  if (!Number.isInteger(stock) || stock < 0) throw new ApiError("Supplier product stock is invalid.", 422);
  const category = draft?.category || stringValue(originalPayload.category);
  if (!category) throw new ApiError("Category is required.", 422);
  const productName = draft?.productName || stringValue(originalPayload.name) || stringValue(queueItem.productName);
  if (!productName) throw new ApiError("Product name is required.", 422);
  const normalizedComparePrice = comparePrice > 0 ? comparePrice : price;
  const discount = normalizedComparePrice > price
    ? Math.round(((normalizedComparePrice - price) / normalizedComparePrice) * 100)
    : 0;
  const specs = record(originalPayload.specs);
  const isActive = draft?.isActive ?? originalPayload.isActive !== false;

  return {
    ...originalPayload,
    id: productId,
    imageUrl: images[0],
    imageUrls: images,
    media: toPublishedProductMedia(managedMedia),
    supplierMedia: managedMedia,
    name: productName,
    shortDescription: draft?.shortDescription ?? originalPayload.shortDescription,
    description: draft?.description ?? originalPayload.description,
    model: draft?.model ?? originalPayload.model,
    barcode: draft?.barcode ?? originalPayload.barcode,
    productType: draft?.productType ?? originalPayload.productType,
    tags: draft?.tags ?? originalPayload.tags,
    keyFeatures: draft?.keyFeatures ?? originalPayload.keyFeatures,
    whatsIncluded: draft?.whatsIncluded ?? originalPayload.whatsIncluded,
    slug: draft?.slug ?? originalPayload.slug,
    metaDescription: draft?.metaDescription ?? originalPayload.metaDescription,
    keywords: draft?.keywords ?? originalPayload.keywords,
    price,
    originalPrice: normalizedComparePrice,
    costPrice: draft?.costPrice ?? Number(originalPayload.costPrice ?? 0),
    marketPrice: draft?.marketPrice ?? Number(originalPayload.marketPrice ?? 0),
    discount,
    stock,
    category,
    subcategory: draft?.subcategory || stringValue(originalPayload.subcategory),
    brand: draft?.brand || stringValue(originalPayload.brand),
    specs: { ...specs, ...(draft?.specifications || {}) },
    isActive,
    isNew: draft?.isNew ?? originalPayload.isNew === true,
    isFeatured: draft?.isFeatured ?? originalPayload.isFeatured === true,
    isBestSeller: draft?.isBestSeller ?? originalPayload.isBestSeller === true,
    active: isActive,
    visible: isActive,
    approved: true,
    published: true,
  };
};

const commercialFieldDeletes = (): Record<string, FieldValue> => Object.fromEntries(
  COMMERCIAL_PRODUCT_FIELDS.map((field) => [field, FieldValue.delete()]),
);

export async function decideSupplierQueueItem(
  db: Firestore,
  queueItemIdInput: unknown,
  action: SupplierQueueDecisionAction,
  reviewer: SupplierAdminReviewer,
  options: {
    draft?: SupplierApprovalDraft;
    rejectionReason?: unknown;
    deletionReason?: unknown;
    resolveConflict?: boolean;
    expectedPendingRevision?: unknown;
  } = {},
  identityDependencies: SupplierApprovalIdentityDependencies = {},
): Promise<SupplierQueueDecisionResult> {
  const requestedQueueItemId = cleanQueueItemId(queueItemIdInput);
  const reviewQueueItemId = cleanQueueItemId(queueIdFor(requestedQueueItemId));
  const rejectionReason = action === "rejected"
    ? cleanText(options.rejectionReason, "Rejection reason", MAX_REJECTION_REASON_LENGTH)
    : "";
  const deletionReason = action === "deleted"
    ? cleanText(options.deletionReason, "Deletion reason", MAX_REJECTION_REASON_LENGTH)
    : "";
  const requestedPendingRevision = cleanPendingRevision(options.expectedPendingRevision);
  let effectiveDraft = options.draft;
  if (action === "approved") {
    const requestedImages = options.draft
      ? normalizeImages(options.draft.primaryImageUrl, options.draft.galleryImageUrls)
      : undefined;
    const media = await ensureSupplierReviewQueueManagedMedia(db, reviewQueueItemId, {
      ...(requestedImages ? { imageUrls: requestedImages } : {}),
      maxImages: MAX_GALLERY_IMAGES,
    });
    if (media.assets.length === 0) throw new ApiError("A valid managed product image is required before publishing.", 422);
    if (options.draft) {
      const managedUrls = media.assets.map((asset) => asset.firebaseStorageUrl);
      effectiveDraft = {
        ...options.draft,
        primaryImageUrl: managedUrls[0],
        galleryImageUrls: managedUrls.slice(1),
      };
    }
  }
  const transactionResult = await db.runTransaction(async (transaction): Promise<{
    productId?: string;
    sku?: string;
    idempotent?: boolean;
    conflict?: SupplierApprovalConflict;
  }> => {
    const reviewReference = db.collection("supplier_review_queue").doc(reviewQueueItemId);
    const pendingReference = db.collection("supplier_pending_changes").doc(`change-${reviewQueueItemId}`);
    const importReference = db.collection("supplier_import_queue").doc(reviewQueueItemId);
    const settingsReference = db.collection("supplier_settings").doc("config");
    const [reviewSnapshot, pendingSnapshot] = await Promise.all([
      transaction.get(reviewReference),
      transaction.get(pendingReference),
    ]);
    const selectedSnapshot = requestedQueueItemId.startsWith("change-") && pendingSnapshot.exists
      ? pendingSnapshot
      : reviewSnapshot;
    if (!selectedSnapshot.exists) throw new ApiError("Supplier review item was already processed or no longer exists.", 409);
    const selectedData = selectedSnapshot.data() || {};
    const selectedState = String(selectedData.queueState || selectedData.status || "").toLowerCase();
    const selectedIsConflict = selectedState === "conflict";
    if (!isPending(selectedData.status) && !selectedIsConflict) {
      const decisionRevision = cleanPendingRevision(selectedData.decisionPendingRevision);
      const decisionAction = String(selectedData.decisionAction || "").toLowerCase();
      if (
        decisionAction === action
        && decisionRevision
        && requestedPendingRevision === decisionRevision
        && stringValue(selectedData.decisionAuditId)
      ) {
        return {
          productId: stringValue(selectedData.decisionProductId || selectedData.canonicalProductId || selectedData.productId) || undefined,
          sku: stringValue(selectedData.zyroSku) || undefined,
          idempotent: true,
        };
      }
      throw new ApiError("Supplier review item is no longer pending; reload and try again.", 409);
    }
    const reviewQueueState = String(reviewSnapshot.data()?.queueState || "").toLowerCase();
    const reviewIsConflict = reviewQueueState === "conflict";
    if (reviewSnapshot.exists && !isPending(reviewSnapshot.data()?.status) && !reviewIsConflict) {
      throw new ApiError("Supplier review item is no longer pending; reload and try again.", 409);
    }
    if (reviewQueueState && reviewQueueState !== "review_pending" && reviewQueueState !== "conflict") {
      throw new ApiError("Supplier review item is not ready for an admin decision; reload and try again.", 409);
    }
    if (action === "approved" && reviewIsConflict && options.resolveConflict !== true) {
      throw new ApiError("This supplier update has an approval conflict and requires explicit administrator resolution.", 409);
    }

    let queueItem: QueueItemRecord = {
      ...(reviewSnapshot.exists ? reviewSnapshot.data() : {}),
      ...(pendingSnapshot.exists ? pendingSnapshot.data() : {}),
      id: requestedQueueItemId,
      reviewQueueItemId,
    };
    if (action === "deleted" && !supplierReviewAllowsDismissal(queueItem)) {
      throw new ApiError("Only conflicts or reviews needing attention can be dismissed.", 409);
    }
    const resolvedQueueIdentity = await resolveSupplierQueueIdentity(db, transaction, queueItem);
    const approvalBaselineCandidate = parseSupplierProductApprovalBaseline(queueItem.approvalBaseline);
    const comparisonStatus = stringValue(
      queueItem.comparisonStatus || record(queueItem.comparison).comparisonStatus,
    ).toUpperCase();
    const createsNewZyroProduct = action === "approved"
      && comparisonStatus === "NEW_PRODUCT"
      && approvalBaselineCandidate?.exists === false
      && resolvedQueueIdentity.offer?.reviewStatus !== "approved";
    const supplierSnapshotForIdentity = record(queueItem.supplierSnapshot);
    const approvalProductId = createsNewZyroProduct
      ? buildZyroProductId({
        offerId: resolvedQueueIdentity.offer?.id,
        sourceId: queueItem.sourceId || supplierSnapshotForIdentity.sourceId,
        supplierId: queueItem.supplierId || supplierSnapshotForIdentity.supplierId,
        supplierProductId: supplierSnapshotForIdentity.supplierProductId
          || supplierSnapshotForIdentity.supplierSku
          || queueItem.supplierCode,
        portalRequestId: queueItem.portalRequestId,
      })
      : resolvedQueueIdentity.canonicalProductId;
    const queueIdentityProjection = buildSupplierQueueIdentityProjection(queueItem, {
      canonicalProductId: approvalProductId,
      supplierOfferId: resolvedQueueIdentity.supplierOfferId,
    });
    queueItem = { ...queueItem, ...queueIdentityProjection };
    const queuePendingRevision = cleanPendingRevision(queueItem.supplierOfferPendingRevision);
    const currentPendingObservation = resolvedQueueIdentity.offer?.pendingObservation || null;
    if (currentPendingObservation) {
      if (currentPendingObservation.reviewQueueItemId !== reviewQueueItemId) {
        throw new ApiError("The supplier observation belongs to a different Product Review item.", 409);
      }
      if (!queuePendingRevision || queuePendingRevision !== currentPendingObservation.revision) {
        throw new ApiError("The supplier observation changed; reload Product Review before deciding.", 409);
      }
      if (!requestedPendingRevision || requestedPendingRevision !== queuePendingRevision) {
        throw new ApiError("Product Review changed after it was opened; reload before deciding.", 409);
      }
    } else if (queuePendingRevision || requestedPendingRevision) {
      throw new ApiError("The supplier observation is no longer pending; reload Product Review.", 409);
    }
    const isSupplierOfferRemoval = action === "approved"
      && stringValue(queueItem.reconciliationAction) === "supplier_offer_unavailable";
    let approvedPayload = action === "approved" ? toPublicProductPayload(queueItem, effectiveDraft) : undefined;
    const categoryReference = approvedPayload ? db.collection("categories").doc(String(approvedPayload.category)) : null;
    const approvedBrandId = approvedPayload ? String(approvedPayload.brand || "").trim() : "";
    const brandReference = approvedBrandId ? db.collection("brands").doc(approvedBrandId) : null;
    const needsCategoryMapping = Boolean(approvedPayload && Array.isArray(record(queueItem.supplierSnapshot).categoryHierarchy));
    const productReference = approvedPayload ? db.collection("products").doc(String(approvedPayload.id)) : null;
    const decisionProductReference = productReference || (resolvedQueueIdentity.offer
      ? db.collection("products").doc(resolvedQueueIdentity.canonicalProductId)
      : null);
    const privateProductReference = approvedPayload ? db.collection(PRODUCT_PRIVATE_COLLECTION).doc(String(approvedPayload.id)) : null;
    const approvedSupplierOffer = resolvedQueueIdentity.offer;
    const supplierOfferReference = resolvedQueueIdentity.offerReference;
    const supplierSnapshot = record(queueItem.supplierSnapshot);
    const categoryHierarchy = supplierSnapshot.categoryHierarchy;
    const supplierCategory = Array.isArray(categoryHierarchy) ? stringValue(categoryHierarchy[0]) : "";
    const normalizedSupplierCategory = normalizeSupplierMappingValue(supplierCategory);
    const supplierSpecifications = record(supplierSnapshot.specifications);
    const supplierBrand = stringValue(supplierSnapshot.brand || supplierSpecifications.brand || supplierSpecifications.Brand);
    const normalizedSupplierBrand = normalizeSupplierMappingValue(supplierBrand);
    const sourceId = stringValue(queueItem.sourceId) || stringValue(supplierSnapshot.sourceId);
    const categoryMappingReference = sourceId && normalizedSupplierCategory
      ? db.collection("supplier_category_mappings").doc(supplierMappingDocumentId(sourceId, normalizedSupplierCategory))
      : null;
    const brandMappingReference = sourceId && normalizedSupplierBrand
      ? db.collection("supplier_brand_mappings").doc(supplierMappingDocumentId(sourceId, normalizedSupplierBrand))
      : null;
    const [
      categorySnapshot,
      brandSnapshot,
      settingsSnapshot,
      existingProductSnapshot,
      existingPrivateProductSnapshot,
      existingCategoryMappingSnapshot,
      existingBrandMappingSnapshot,
      productOffersSnapshot,
    ] = await Promise.all([
      categoryReference ? transaction.get(categoryReference) : Promise.resolve(null),
      brandReference ? transaction.get(brandReference) : Promise.resolve(null),
      needsCategoryMapping ? transaction.get(settingsReference) : Promise.resolve(null),
      decisionProductReference ? transaction.get(decisionProductReference) : Promise.resolve(null),
      privateProductReference ? transaction.get(privateProductReference) : Promise.resolve(null),
      categoryMappingReference ? transaction.get(categoryMappingReference) : Promise.resolve(null),
      brandMappingReference ? transaction.get(brandMappingReference) : Promise.resolve(null),
      approvedPayload
        ? transaction.get(db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("productId", "==", String(approvedPayload.id)).limit(100))
        : Promise.resolve(null),
    ]);
    const now = FieldValue.serverTimestamp();
    const previousState = reviewQueueState || "review_pending";
    const legacyAmbiguousPendingOffer = Boolean(
      approvedSupplierOffer
      && !currentPendingObservation
      && approvedSupplierOffer.reviewStatus === "review_pending"
      && existingProductSnapshot?.exists
      && stringValue(queueItem.comparisonStatus) !== "NEW_PRODUCT",
    );
    if (legacyAmbiguousPendingOffer) {
      throw new ApiError(
        "This legacy pending supplier offer has no provable approved baseline. Run a fresh sync and review the new observation.",
        409,
      );
    }

    if (approvedPayload && productReference) {
      const approvalBaseline = approvalBaselineCandidate?.productId === String(approvedPayload.id)
        ? approvalBaselineCandidate
        : createsNewZyroProduct && approvalBaselineCandidate?.exists === false
          ? buildSupplierProductApprovalBaseline(
            String(approvedPayload.id),
            undefined,
            approvalBaselineCandidate.capturedAt,
          )
        : null;
      const currentProduct = existingProductSnapshot?.exists ? existingProductSnapshot.data() : undefined;
      const conflict = detectSupplierApprovalConflict(approvalBaseline, String(approvedPayload.id), currentProduct);
      if (conflict) {
        const conflictBaseline = rebaseSupplierApprovalConflict(
          approvalBaseline,
          String(approvedPayload.id),
          currentProduct,
        );
        const conflictRecord = {
          ...conflict,
          supplierSnapshot: record(queueItem.supplierSnapshot),
          detectedAt: now,
          detectedBy: reviewer,
        };
        const conflictAuditId = createSupplierAuditEvent(db, transaction, {
          queueItemId: reviewQueueItemId,
          queueItem,
          action: "approval_conflict",
          previousState,
          newState: "conflict",
          admin: reviewer,
          reason: conflict.reason,
          beforePublicProduct: currentProduct,
          afterPublicProduct: currentProduct,
          beforePrivateProduct: existingPrivateProductSnapshot?.exists ? existingPrivateProductSnapshot.data() : undefined,
          afterPrivateProduct: existingPrivateProductSnapshot?.exists ? existingPrivateProductSnapshot.data() : undefined,
          conflict,
          timestamp: now,
        });
        const conflictUpdate = {
          ...queueIdentityProjection,
          queueState: "conflict",
          status: "CONFLICT",
          approvalConflict: conflictRecord,
          approvalBaseline: conflictBaseline,
          conflictAuditId,
          approvalAttemptCount: FieldValue.increment(1),
          updatedAt: now,
        };
        transaction.set(reviewReference, conflictUpdate, { merge: true });
        if (pendingSnapshot.exists) transaction.set(pendingReference, conflictUpdate, { merge: true });
        return { conflict };
      }
    }

    let decisionSupplierOffer = approvedSupplierOffer;
    if (action === "approved" && approvedSupplierOffer && currentPendingObservation) {
      try {
        decisionSupplierOffer = promoteSupplierOfferPendingObservation(
          approvedSupplierOffer,
          currentPendingObservation.revision,
        );
      } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : "The supplier observation could not be promoted.", 409);
      }
    }
    const currentOfferSelection = parseSupplierOfferSelection(existingPrivateProductSnapshot?.data()?.supplierOfferSelection);
    const approvedOffers = (productOffersSnapshot?.docs || [])
      .map((document) => projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
      .filter((offer): offer is SupplierProductOffer => Boolean(offer))
      .map((offer) => decisionSupplierOffer && offer.id === decisionSupplierOffer.id
        ? { ...decisionSupplierOffer, reviewStatus: isSupplierOfferRemoval ? decisionSupplierOffer.reviewStatus : "approved" as const }
        : offer)
      .filter((offer) => offer.reviewStatus === "approved" && (!isSupplierOfferRemoval || offer.id !== decisionSupplierOffer?.id));
    if (decisionSupplierOffer && !isSupplierOfferRemoval && !approvedOffers.some((offer) => offer.id === decisionSupplierOffer.id)) {
      approvedOffers.push({ ...decisionSupplierOffer, reviewStatus: "approved" });
    }
    const activeSupplierOffer = decisionSupplierOffer && approvedPayload
      ? (isSupplierOfferRemoval
        ? resolveActiveSupplierOffer(approvedOffers, currentOfferSelection)
        : !currentOfferSelection.activeOfferId
          ? decisionSupplierOffer
          : resolveActiveSupplierOffer(approvedOffers, currentOfferSelection) || decisionSupplierOffer)
      : null;
    const activeCommerceOffer = activeSupplierOffer && isSupplierOfferAvailableForCommerce(activeSupplierOffer)
      ? activeSupplierOffer
      : null;
    const projectedSupplierOffer = isSupplierOfferRemoval ? activeCommerceOffer : activeSupplierOffer;
    const nextOfferSelection = decisionSupplierOffer && approvedPayload ? {
      ...currentOfferSelection,
      activeOfferId: activeCommerceOffer?.id || (isSupplierOfferRemoval ? null : activeSupplierOffer?.id || null),
      updatedAt: now,
      updatedBy: reviewer.uid,
    } : currentOfferSelection;
    const shouldProjectApprovedOffer = isSupplierOfferRemoval
      || !approvedSupplierOffer
      || !existingProductSnapshot?.exists
      || nextOfferSelection.activeOfferId === decisionSupplierOffer?.id;

    let resolvedOwnership = existingPrivateProductSnapshot?.data()?.supplierFieldOwnership;
    if (approvedPayload && isSupplierOfferRemoval) {
      const approvalBaseline = parseSupplierProductApprovalBaseline(queueItem.approvalBaseline);
      approvedPayload = {
        ...approvedPayload,
        ...buildSupplierRemovalPublicProjection(
          activeCommerceOffer,
          existingProductSnapshot?.data(),
          approvalBaseline?.stockAtCapture,
        ),
      };
    }
    if (approvedPayload && decisionSupplierOffer) approvedPayload.supplierOfferSelection = nextOfferSelection;
    if (approvedPayload && projectedSupplierOffer) {
      approvedPayload.fulfilmentMode = "supplier";
      approvedPayload.supplierId = projectedSupplierOffer.supplierId;
      approvedPayload.supplierSourceId = projectedSupplierOffer.sourceId;
      approvedPayload.supplierItemCode = projectedSupplierOffer.sku;
      approvedPayload.costPrice = effectiveDraft?.costPrice ?? projectedSupplierOffer.cost;
      approvedPayload.supplierMetadata = {
        ...record(approvedPayload.supplierMetadata),
        supplierProductId: projectedSupplierOffer.supplierProductId,
        sku: projectedSupplierOffer.sku,
        barcode: projectedSupplierOffer.barcode,
        inventoryLevel: projectedSupplierOffer.stock,
        price: projectedSupplierOffer.price,
        availability: projectedSupplierOffer.availability,
        activeOfferId: projectedSupplierOffer.id,
      };
    } else if (approvedPayload && isSupplierOfferRemoval) {
      approvedPayload.supplierId = "";
      approvedPayload.supplierSourceId = "";
      approvedPayload.supplierItemCode = "";
      approvedPayload.costPrice = 0;
      approvedPayload.supplierMetadata = {
        ...record(approvedPayload.supplierMetadata),
        inventoryLevel: 0,
        availability: "unavailable",
        activeOfferId: null,
      };
    }

    let zyroSkuClaimId = "";
    if (approvedPayload) {
      await assertZyroBarcodeAvailable(
        db,
        transaction,
        String(approvedPayload.id),
        approvedPayload.barcode,
      );
      const existingSku = stringValue(existingPrivateProductSnapshot?.data()?.sku)
        || stringValue(existingProductSnapshot?.data()?.sku);
      if (existingSku) {
        approvedPayload.sku = existingSku;
      } else {
        const productId = String(approvedPayload.id);
        const reservation = await reserveZyroSku(
          db,
          transaction,
          productId,
          identityDependencies.buildSkuCandidates?.(productId),
        );
        approvedPayload.sku = reservation.sku;
        zyroSkuClaimId = reservation.claimId;
      }
    }

    // Apply ownership after the active supplier offer is projected. This is
    // important for private commercial values: an administrator-owned cost or
    // market price must not be overwritten by a later supplier approval.
    if (approvedPayload) {
      const currentProduct = existingProductSnapshot?.exists ? {
        ...existingProductSnapshot.data(),
        ...(existingPrivateProductSnapshot?.data() || {}),
      } : undefined;
      const ownershipResult = applySupplierProductFieldOwnership({
        proposedProduct: approvedPayload,
        currentProduct,
        existingOwnership: resolvedOwnership,
        requestedOwnership: effectiveDraft?.fieldOwnership,
        editedFields: effectiveDraft?.editedFields,
        sourceId,
        reviewerId: reviewer.uid,
        timestamp: now,
      });
      resolvedOwnership = ownershipResult.ownership;
      if (shouldProjectApprovedOffer || !existingProductSnapshot?.exists) {
        approvedPayload = ownershipResult.product;
      } else {
        const preservedProduct: Record<string, unknown> = {
          ...currentProduct,
          id: String(approvedPayload.id),
        };
        for (const field of effectiveDraft?.editedFields || []) {
          if (Object.hasOwn(ownershipResult.product, field)) preservedProduct[field] = ownershipResult.product[field];
          else delete preservedProduct[field];
        }
        approvedPayload = preservedProduct;
      }
      approvedPayload.supplierFieldOwnership = resolvedOwnership;
    }

    // Approving the removal is itself the administrator's explicit decision
    // to withdraw the product when no approved replacement offer exists.
    // Legacy field-ownership defaults must not restore the live stock or
    // visibility values after the controlled removal projection is built.
    if (approvedPayload && isSupplierOfferRemoval && !activeCommerceOffer) {
      Object.assign(
        approvedPayload,
        buildSupplierRemovalPublicProjection(null, existingProductSnapshot?.data()),
      );
    }

    if (approvedPayload) {
      const categoryData = categorySnapshot?.exists ? categorySnapshot.data() || {} : {};
      const brandData = brandSnapshot?.exists ? brandSnapshot.data() || {} : {};
      const validationErrors = validateSupplierProductForApproval(
        approvedPayload,
        categorySnapshot?.exists ? [{
          id: categorySnapshot.id,
          name: stringValue(categoryData.name) || categorySnapshot.id,
          isActive: categoryData.isActive !== false,
          subcategories: Array.isArray(categoryData.subcategories) ? categoryData.subcategories : [],
          specificationTemplate: Array.isArray(categoryData.specificationTemplate) ? categoryData.specificationTemplate : [],
        }] : [],
        brandSnapshot?.exists ? [{
          id: brandSnapshot.id,
          name: stringValue(brandData.name) || brandSnapshot.id,
          isActive: brandData.isActive !== false,
        }] : [],
      );
      if (validationErrors.length > 0) {
        throw new ApiError(
          "Supplier product validation failed.",
          422,
          validationErrors[0].message,
          { validationErrors },
        );
      }
      approvedPayload.specs = {
        ...record(approvedPayload.specs),
        Brand: stringValue(brandData.name) || String(approvedPayload.brand),
      };
    }

    let decidedProductId = "";
    let approvedProductPayload = approvedPayload;

    if (approvedPayload) {
      decidedProductId = String(approvedPayload.id);
      const approvalBaseline = parseSupplierProductApprovalBaseline(queueItem.approvalBaseline);
      const stockOwnership = record(resolvedOwnership).stock;
      const stockOwner = typeof stockOwnership === "string" ? stockOwnership : stringValue(record(stockOwnership).owner);
      const stockWasEdited = effectiveDraft?.editedFields?.includes("stock") === true;
      approvedProductPayload = {
        ...approvedPayload,
        stock: isSupplierOfferRemoval
          ? Number(approvedPayload.stock ?? 0)
          : stockOwner === "admin" && !stockWasEdited && existingProductSnapshot?.exists
          ? Number(existingProductSnapshot.data()?.stock ?? 0)
          : !shouldProjectApprovedOffer && !stockWasEdited && existingProductSnapshot?.exists
            ? Number(existingProductSnapshot.data()?.stock ?? 0)
          : reconcileSupplierApprovalStock(
            approvalBaseline?.stockAtCapture,
            existingProductSnapshot?.data()?.stock,
            approvedPayload.stock,
            existingProductSnapshot?.exists === true,
          ),
        updatedAt: now,
      };
      const { publicData, commercialData } = splitProductData(approvedProductPayload);
      transaction.set(db.collection("products").doc(decidedProductId), {
        ...publicData,
        ...commercialFieldDeletes(),
      }, { merge: true });
      if (Object.keys(commercialData).length > 0) {
        transaction.set(db.collection(PRODUCT_PRIVATE_COLLECTION).doc(decidedProductId), {
          ...commercialData,
          productId: decidedProductId,
          updatedAt: now,
        }, { merge: true });
      }
      if (supplierOfferReference && decisionSupplierOffer) {
        transaction.set(supplierOfferReference, {
          ...(currentPendingObservation ? decisionSupplierOffer : {}),
          productId: decidedProductId,
          reviewStatus: "approved",
          pendingObservation: null,
          stateVersion: currentPendingObservation
            ? decisionSupplierOffer.stateVersion
            : decisionSupplierOffer.stateVersion + 1,
          approvedAt: now,
          approvedBy: reviewer.uid,
          updatedAt: now,
        }, { merge: true });
      }
      const managedMedia = extractSupplierMediaFromRecord(commercialData.supplierMedia);
      managedMedia.forEach((asset) => {
        transaction.set(db.collection(SUPPLIER_MEDIA_COLLECTION).doc(asset.contentHash), {
          imageStatus: "published",
          publishedAt: now,
          lastPublishedProductId: decidedProductId,
          publishCount: FieldValue.increment(1),
        }, { merge: true });
      });
      const legacySupplierCategory = normalizeSupplierCategory(supplierCategory);
      if (legacySupplierCategory) {
        const categoryMappings = record(settingsSnapshot?.data()?.categoryMappings);
        if (categoryMappings[legacySupplierCategory] !== approvedPayload.category) {
          transaction.set(settingsReference, {
            categoryMappings: { ...categoryMappings, [legacySupplierCategory]: approvedPayload.category },
          }, { merge: true });
        }
      }
      if (categoryMappingReference && normalizedSupplierCategory) {
        const previous = existingCategoryMappingSnapshot?.data() || {};
        const changed = previous.targetCategoryId !== approvedPayload.category
          || previous.targetSubcategoryId !== approvedPayload.subcategory;
        if (changed) {
          const version = Math.max(0, Number(previous.version) || 0) + 1;
          const mapping = {
            sourceId,
            supplierCategory,
            normalizedCategory: normalizedSupplierCategory,
            targetCategoryId: String(approvedPayload.category),
            targetSubcategoryId: String(approvedPayload.subcategory || ""),
            confidence: 100,
            mappingType: "learned",
            version,
            updatedBy: reviewer.uid,
            updatedAt: now,
          };
          transaction.set(categoryMappingReference, mapping, { merge: true });
          transaction.create(db.collection("supplier_mapping_audit").doc(), {
            mappingKind: "category",
            mappingId: categoryMappingReference.id,
            sourceId,
            queueItemId: reviewQueueItemId,
            action: "learned_after_approval",
            previous: previous.targetCategoryId ? previous : null,
            current: mapping,
            adminUserId: reviewer.uid,
            adminEmail: reviewer.email,
            timestamp: now,
          });
        }
      }
      if (brandMappingReference && normalizedSupplierBrand) {
        const previous = existingBrandMappingSnapshot?.data() || {};
        const changed = previous.mappedBrandId !== approvedPayload.brand;
        if (changed) {
          const version = Math.max(0, Number(previous.version) || 0) + 1;
          const mapping = {
            sourceId,
            supplierBrand,
            normalizedBrand: normalizedSupplierBrand,
            mappedBrandId: String(approvedPayload.brand),
            confidence: 100,
            mappingType: "learned",
            version,
            updatedBy: reviewer.uid,
            updatedAt: now,
          };
          transaction.set(brandMappingReference, mapping, { merge: true });
          transaction.create(db.collection("supplier_mapping_audit").doc(), {
            mappingKind: "brand",
            mappingId: brandMappingReference.id,
            sourceId,
            queueItemId: reviewQueueItemId,
            action: "learned_after_approval",
            previous: previous.mappedBrandId ? previous : null,
            current: mapping,
            adminUserId: reviewer.uid,
            adminEmail: reviewer.email,
            timestamp: now,
          });
        }
      }
    }

    const portalRequestId = stringValue(queueItem.portalRequestId);
    const supplierId = stringValue(queueItem.supplierId);
    if (portalRequestId && supplierId) {
      const requestStatus = action === "approved" ? "approved" : "rejected";
      const reason = action === "rejected" ? rejectionReason : action === "deleted" ? deletionReason : "";
      transaction.set(db.collection("supplier_product_requests").doc(portalRequestId), {
        status: requestStatus,
        ...(action === "approved" && decidedProductId ? { productId: decidedProductId } : {}),
        reviewedAt: now,
        reviewedBy: reviewer,
        ...(reason ? { rejectionReason: reason } : {}),
      }, { merge: true });
      transaction.set(db.collection("supplier_notifications").doc(`${portalRequestId}-${action}`), {
        supplierId,
        type: action === "approved" ? "product_approved" : "product_rejected",
        title: action === "approved" ? "Product approved" : "Product rejected",
        message: action === "approved" ? `${stringValue(queueItem.productName) || "Your product"} was approved.` : reason,
        productRequestId: portalRequestId,
        isRead: false,
        createdAt: now,
      });
      if (action !== "approved") {
        const supplierSkuClaimId = stringValue(queueItem.supplierSkuClaimId);
        const productFingerprintClaimId = stringValue(queueItem.productFingerprintClaimId);
        if (supplierSkuClaimId) transaction.delete(db.collection("supplier_sku_claims").doc(supplierSkuClaimId));
        if (productFingerprintClaimId) transaction.delete(db.collection("supplier_product_claims").doc(productFingerprintClaimId));
      }
    }

    const terminalState = action === "approved" ? "approved" : action === "rejected" ? "rejected" : "suppressed";
    if (action !== "approved" && supplierOfferReference && approvedSupplierOffer) {
      const preservesApprovedEffectiveState = approvedSupplierOffer.reviewStatus === "approved";
      transaction.set(supplierOfferReference, {
        reviewStatus: preservesApprovedEffectiveState ? "approved" : terminalState,
        pendingObservation: null,
        stateVersion: approvedSupplierOffer.stateVersion + 1,
        reviewedAt: now,
        reviewedBy: reviewer.uid,
        updatedAt: now,
      }, { merge: true });
    }
    const approvedProduct = approvedProductPayload ? splitProductData(approvedProductPayload) : undefined;
    const auditId = createSupplierAuditEvent(db, transaction, {
      queueItemId: reviewQueueItemId,
      queueItem: {
        ...queueItem,
        ...(decidedProductId ? { productId: decidedProductId, canonicalProductId: decidedProductId } : {}),
        ...(approvedProductPayload?.sku ? { zyroSku: approvedProductPayload.sku } : {}),
      },
      action: action === "approved" ? "approve" : action === "rejected" ? "reject" : "delete",
      previousState,
      newState: terminalState,
      admin: reviewer,
      reason: action === "rejected" ? rejectionReason : action === "deleted" ? deletionReason : undefined,
      beforePublicProduct: existingProductSnapshot?.exists ? existingProductSnapshot.data() : undefined,
      beforePrivateProduct: existingPrivateProductSnapshot?.exists ? existingPrivateProductSnapshot.data() : undefined,
      afterPublicProduct: approvedProduct?.publicData,
      afterPrivateProduct: approvedProduct?.commercialData,
      timestamp: now,
    });
    transaction.set(reviewReference, {
      ...queueIdentityProjection,
      ...(decidedProductId ? {
        canonicalProductId: decidedProductId,
        productId: decidedProductId,
        productPayload: {
          ...record(queueIdentityProjection.productPayload),
          id: decidedProductId,
        },
      } : {}),
      queueState: terminalState,
      status: action === "approved" ? "Approved" : "Rejected",
      decisionAction: action,
      decisionAuditId: auditId,
      decisionPendingRevision: queuePendingRevision || null,
      ...(decidedProductId ? { decisionProductId: decidedProductId } : {}),
      ...(approvedProductPayload?.sku ? { zyroSku: approvedProductPayload.sku } : {}),
      ...(zyroSkuClaimId ? { zyroSkuClaimId } : {}),
      decisionCompletedAt: now,
      decisionCompletedBy: reviewer,
      approvalConflict: FieldValue.delete(),
    }, { merge: true });
    transaction.delete(pendingReference);
    transaction.delete(importReference);
    return {
      ...(decidedProductId ? { productId: decidedProductId } : {}),
      ...(approvedProductPayload?.sku ? { sku: String(approvedProductPayload.sku) } : {}),
    };
  });

  if (transactionResult.conflict) {
    return {
      success: false,
      error: "The live product changed after this supplier update was queued. Review the conflict before publishing.",
      queueItemId: requestedQueueItemId,
      action: "approved",
      status: "conflict",
      conflict: transactionResult.conflict,
    };
  }

  return {
    success: true,
    queueItemId: requestedQueueItemId,
    action,
    status: action,
    ...(transactionResult.productId ? { productId: transactionResult.productId } : {}),
    ...(transactionResult.sku ? { sku: transactionResult.sku } : {}),
    ...(transactionResult.idempotent ? { idempotent: true } : {}),
  };
}
