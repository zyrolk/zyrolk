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
  detectSupplierApprovalConflict,
  parseSupplierProductApprovalBaseline,
  rebaseSupplierApprovalConflict,
  reconcileSupplierApprovalStock,
  SupplierApprovalConflict,
} from "./supplierApprovalConcurrency";
import { ensureSupplierReviewQueueManagedMedia } from "../../scheduled/supplierReviewQueue";

// Every decision transaction appends an immutable supplier_approval_audit event
// through the shared server-only audit trail helper.

export interface SupplierApprovalDraft {
  productName: string;
  sellingPrice: number;
  comparePrice: number;
  stock: number;
  category: string;
  subcategory?: string;
  brand: string;
  specifications?: Record<string, string>;
  isActive: boolean;
  primaryImageUrl: string;
  galleryImageUrls: string[];
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

export function parseSupplierApprovalDraft(value: unknown): SupplierApprovalDraft | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Review draft must be an object.", 400);
  }
  const draft = value as Record<string, unknown>;
  const productName = cleanText(draft.productName, "Product name", 300);
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

  const sellingPrice = cleanNumber(draft.sellingPrice, "Selling price", { minimum: Number.EPSILON });
  const comparePrice = cleanNumber(draft.comparePrice, "Compare price", { minimum: 0 });
  if (comparePrice > 0 && comparePrice < sellingPrice) {
    throw new ApiError("Compare price must be at least the selling price.", 400);
  }

  return {
    productName,
    sellingPrice,
    comparePrice,
    stock: cleanNumber(draft.stock, "Stock", { integer: true, minimum: 0 }),
    category,
    ...(subcategory !== undefined ? { subcategory } : {}),
    brand,
    ...(specifications !== undefined ? { specifications } : {}),
    isActive: draft.isActive,
    primaryImageUrl,
    galleryImageUrls,
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

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";

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
    price,
    originalPrice: normalizedComparePrice,
    discount,
    stock,
    category,
    subcategory: draft?.subcategory || stringValue(originalPayload.subcategory),
    brand: draft?.brand || stringValue(originalPayload.brand),
    specs: { ...specs, ...(draft?.specifications || {}) },
    isActive,
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
  options: { draft?: SupplierApprovalDraft; rejectionReason?: unknown; deletionReason?: unknown; resolveConflict?: boolean } = {},
): Promise<SupplierQueueDecisionResult> {
  const requestedQueueItemId = cleanQueueItemId(queueItemIdInput);
  const reviewQueueItemId = cleanQueueItemId(queueIdFor(requestedQueueItemId));
  const rejectionReason = action === "rejected"
    ? cleanText(options.rejectionReason, "Rejection reason", MAX_REJECTION_REASON_LENGTH)
    : "";
  const deletionReason = action === "deleted"
    ? cleanText(options.deletionReason, "Deletion reason", MAX_REJECTION_REASON_LENGTH)
    : "";
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
  const transactionResult = await db.runTransaction(async (transaction): Promise<{ productId?: string; conflict?: SupplierApprovalConflict }> => {
    const reviewReference = db.collection("supplier_review_queue").doc(reviewQueueItemId);
    const pendingReference = db.collection("supplier_pending_changes").doc(`change-${reviewQueueItemId}`);
    const importReference = db.collection("supplier_import_queue").doc(reviewQueueItemId);
    const settingsReference = db.collection("supplier_settings").doc("config");
    const [reviewSnapshot, pendingSnapshot] = await Promise.all([
      transaction.get(reviewReference),
      transaction.get(pendingReference),
    ]);
    const selectedSnapshot = requestedQueueItemId.startsWith("change-") ? pendingSnapshot : reviewSnapshot;
    if (!selectedSnapshot.exists) throw new ApiError("Supplier review item was already processed or no longer exists.", 409);
    const selectedState = String(selectedSnapshot.data()?.queueState || selectedSnapshot.data()?.status || "").toLowerCase();
    const selectedIsConflict = selectedState === "conflict";
    if (!isPending(selectedSnapshot.data()?.status) && !selectedIsConflict) {
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

    const queueItem: QueueItemRecord = {
      ...(reviewSnapshot.exists ? reviewSnapshot.data() : {}),
      ...(pendingSnapshot.exists ? pendingSnapshot.data() : {}),
      id: requestedQueueItemId,
      reviewQueueItemId,
    };
    const approvedPayload = action === "approved" ? toPublicProductPayload(queueItem, effectiveDraft) : undefined;
    const categoryReference = approvedPayload ? db.collection("categories").doc(String(approvedPayload.category)) : null;
    const approvedBrandId = approvedPayload ? String(approvedPayload.brand || "").trim() : "";
    const brandReference = approvedBrandId ? db.collection("brands").doc(approvedBrandId) : null;
    const needsCategoryMapping = Boolean(approvedPayload && Array.isArray(record(queueItem.supplierSnapshot).categoryHierarchy));
    const productReference = approvedPayload ? db.collection("products").doc(String(approvedPayload.id)) : null;
    const privateProductReference = approvedPayload ? db.collection(PRODUCT_PRIVATE_COLLECTION).doc(String(approvedPayload.id)) : null;
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
    ] = await Promise.all([
      categoryReference ? transaction.get(categoryReference) : Promise.resolve(null),
      brandReference ? transaction.get(brandReference) : Promise.resolve(null),
      needsCategoryMapping ? transaction.get(settingsReference) : Promise.resolve(null),
      productReference ? transaction.get(productReference) : Promise.resolve(null),
      privateProductReference ? transaction.get(privateProductReference) : Promise.resolve(null),
      categoryMappingReference ? transaction.get(categoryMappingReference) : Promise.resolve(null),
      brandMappingReference ? transaction.get(brandMappingReference) : Promise.resolve(null),
    ]);
    const now = FieldValue.serverTimestamp();
    const previousState = reviewQueueState || "review_pending";

    if (approvedPayload && productReference) {
      const approvalBaselineCandidate = parseSupplierProductApprovalBaseline(queueItem.approvalBaseline);
      const approvalBaseline = approvalBaselineCandidate?.productId === String(approvedPayload.id)
        ? approvalBaselineCandidate
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
      approvedProductPayload = {
        ...approvedPayload,
        stock: reconcileSupplierApprovalStock(
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
    const approvedProduct = approvedProductPayload ? splitProductData(approvedProductPayload) : undefined;
    const auditId = createSupplierAuditEvent(db, transaction, {
      queueItemId: reviewQueueItemId,
      queueItem: { ...queueItem, ...(decidedProductId ? { productId: decidedProductId } : {}) },
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
      queueState: terminalState,
      status: action === "approved" ? "Approved" : "Rejected",
      decisionAction: action,
      decisionAuditId: auditId,
      decisionCompletedAt: now,
      decisionCompletedBy: reviewer,
      approvalConflict: FieldValue.delete(),
    }, { merge: true });
    transaction.delete(pendingReference);
    transaction.delete(importReference);
    return { ...(decidedProductId ? { productId: decidedProductId } : {}) };
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
  };
}
