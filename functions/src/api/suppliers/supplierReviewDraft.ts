import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  parseSupplierProductFieldOwnership,
  SupplierProductFieldOwnership,
} from "./supplierFieldOwnership";
import {
  isCanonicalActiveCategory,
  requiresUnsupportedVariantSelection,
  StoreCategoryMappingCandidate,
  validateSupplierProductForApproval,
} from "./supplierProductMapping";
import { classifySupplierMediaReadiness } from "./supplierMediaReadiness";
import { lowSupplierStockValidationError } from "./supplierLowStockPolicy";
import {
  buildSupplierReviewBusinessQueueProjection,
  decorateSupplierReviewQueueAdminMedia,
  supplierReviewRecordIsLowStockHold,
} from "../../scheduled/supplierReviewQueue";

const DRAFT_FIELDS = new Set([
  "categoryId",
  "subcategoryId",
  "expectedPendingRevision",
  "expectedUpdatedAt",
]);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const cleanText = (value: unknown, field: string, options: { required?: boolean; maxLength?: number } = {}): string => {
  if (typeof value !== "string") throw new ApiError(`${field} must be text.`, 400);
  const cleaned = value.trim();
  if (options.required !== false && !cleaned) throw new ApiError(`${field} is required.`, 400);
  if (cleaned.length > (options.maxLength || 160)) throw new ApiError(`${field} is invalid.`, 400);
  return cleaned;
};

const cleanRevision = (value: unknown): string => {
  const revision = cleanText(value, "expectedPendingRevision");
  if (!/^[a-f0-9]{64}$/u.test(revision)) throw new ApiError("expectedPendingRevision is invalid.", 400);
  return revision;
};

const cleanUpdatedAt = (value: unknown): string => {
  const updatedAt = cleanText(value, "expectedUpdatedAt", { maxLength: 80 });
  if (!Number.isFinite(Date.parse(updatedAt))) throw new ApiError("expectedUpdatedAt is invalid.", 400);
  return updatedAt;
};

export interface SupplierReviewDraftInput {
  categoryId: string;
  subcategoryId: string;
  expectedPendingRevision: string;
  expectedUpdatedAt: string;
}

export interface SupplierReviewDraftReviewer {
  uid: string;
  email: string;
}

export function parseSupplierReviewDraftInput(value: unknown): SupplierReviewDraftInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Supplier review draft is invalid.", 400);
  }
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((field) => !DRAFT_FIELDS.has(field));
  if (unknownFields.length > 0) throw new ApiError(`Supplier review draft contains unsupported fields: ${unknownFields.join(", ")}.`, 400);
  return {
    categoryId: cleanText(input.categoryId, "categoryId"),
    subcategoryId: input.subcategoryId === undefined
      ? ""
      : cleanText(input.subcategoryId, "subcategoryId", { required: false }),
    expectedPendingRevision: cleanRevision(input.expectedPendingRevision),
    expectedUpdatedAt: cleanUpdatedAt(input.expectedUpdatedAt),
  };
}

const timestampString = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === "function") return candidate.toDate().toISOString();
    if (typeof candidate.toMillis === "function") return new Date(candidate.toMillis()).toISOString();
  }
  return "";
};

const taxonomyOwnership = (
  existing: unknown,
  reviewer: SupplierReviewDraftReviewer,
  updatedAt: string,
): SupplierProductFieldOwnership => {
  const ownership = parseSupplierProductFieldOwnership(existing);
  return {
    ...ownership,
    category: {
      owner: "admin",
      sourceId: null,
      updatedAt,
      updatedBy: reviewer.uid.slice(0, 160),
      reason: "review_decision",
    },
    subcategory: {
      owner: "admin",
      sourceId: null,
      updatedAt,
      updatedBy: reviewer.uid.slice(0, 160),
      reason: "review_decision",
    },
  };
};

const validationErrorKey = (error: Record<string, unknown>): string => (
  [error.field, error.code, error.message].map((value) => String(value || "").trim()).join("\u0000")
);

const TAXONOMY_WARNING_CODES = new Set([
  "missing_category",
  "missing_subcategory",
  "invalid_category",
  "invalid_subcategory",
  "inactive_category",
  "inactive_subcategory",
  "category_required",
  "subcategory_required",
]);

const isNonEmptyCollection = (value: unknown): boolean => (
  Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === "object" && Object.keys(value).length > 0)
);

const warningStillAppliesToPayload = (warning: Record<string, unknown>, payload: Record<string, unknown>): boolean => {
  const field = String(warning.field || "").trim();
  const code = String(warning.code || "").trim();
  if (field === "category" || field === "subcategory" || TAXONOMY_WARNING_CODES.has(code)) return false;
  if (["missing_brand", "brand_missing"].includes(code)) return !String(payload.brand || "").trim();
  if (code === "missing_images") return !/^https?:\/\/\S+$/iu.test(String(payload.imageUrl || "").trim());
  if (code === "missing_price") return !(Number.isFinite(Number(payload.price)) && Number(payload.price) > 0);
  if (code === "missing_cost") {
    const metadata = asRecord(payload.supplierMetadata);
    return metadata.supplierCostAvailable === false && !(Number.isFinite(Number(payload.costPrice)) && Number(payload.costPrice) >= 0);
  }
  if (code === "missing_stock") {
    return asRecord(payload.supplierMetadata).supplierStockAvailable === false;
  }
  if (code === "invalid_stock") {
    return !Number.isInteger(Number(payload.stock)) || Number(payload.stock) < 0;
  }
  if (code === "missing_specifications") return !isNonEmptyCollection(payload.specs);
  if (code === "missing_variant_data") {
    return isNonEmptyCollection(payload.options) !== isNonEmptyCollection(payload.variants);
  }
  if (code === "unsupported_variant_selection") return requiresUnsupportedVariantSelection(payload);
  return false;
};

const currentImportWarnings = (
  previous: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown>[] => (
  (Array.isArray(previous.warnings) ? previous.warnings : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .filter((warning) => warningStillAppliesToPayload(warning, payload))
);

const currentManagedMediaError = (
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> | null => {
  const supplierSnapshot = asRecord(current.supplierSnapshot);
  const hasMediaState = [
    "mediaReadiness",
    "mediaStatus",
    "managedMedia",
    "mediaFailures",
    "mediaSourceImageUrls",
  ].some((field) => Object.hasOwn(current, field))
    || Object.hasOwn(supplierSnapshot, "managedMedia")
    || Object.hasOwn(supplierSnapshot, "mediaFailures");
  if (!hasMediaState) return null;
  const sourceImageUrls = Array.isArray(current.mediaSourceImageUrls)
    ? current.mediaSourceImageUrls
    : Array.isArray(payload.imageUrls)
      ? payload.imageUrls
      : String(payload.imageUrl || "").trim() ? [payload.imageUrl] : [];
  const managedMedia = current.managedMedia
    ?? supplierSnapshot.managedMedia
    ?? payload.media
    ?? payload.supplierMedia;
  const mediaFailures = current.mediaFailures ?? supplierSnapshot.mediaFailures;
  const readiness = classifySupplierMediaReadiness({
    supplierId: current.supplierId || current.sourceId || supplierSnapshot.supplierId,
    sourceImageUrls,
    managedMedia,
    mediaFailures,
  });
  if (readiness.publicationSafe) return null;
  return {
    field: "images",
    code: "managed_media_required",
    message: readiness.hasUsablePrimary && readiness.usableAssetCount > 0
      ? "Supplier media contains a blocking image failure before publishing."
      : "At least one valid managed primary product image is required before publishing.",
  };
};

const buildReviewValidationPayload = (
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> => ({
  ...payload,
  name: payload.name || current.productName || current.title || "",
  description: payload.description ?? current.description ?? "",
  imageUrl: payload.imageUrl || current.imageUrl || "",
  price: payload.price ?? current.price ?? current.marketPrice,
  costPrice: payload.costPrice ?? current.costPrice,
  stock: payload.stock ?? current.stock,
  isActive: payload.isActive ?? current.isActive,
  active: payload.active ?? current.active,
  visible: payload.visible ?? current.visible,
});

const recomputeProductValidation = async (
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  categorySnapshot: FirebaseFirestore.DocumentSnapshot,
): Promise<Record<string, unknown>> => {
  const categoryData = categorySnapshot.data() || {};
  const category: StoreCategoryMappingCandidate = {
    id: categorySnapshot.id,
    name: String(categoryData.name || categorySnapshot.id),
    isActive: categoryData.isActive === true,
    taxonomyCandidate: categoryData.taxonomyCandidate === true,
    subcategories: Array.isArray(categoryData.subcategories) ? categoryData.subcategories as StoreCategoryMappingCandidate["subcategories"] : [],
    specificationTemplate: Array.isArray(categoryData.specificationTemplate)
      ? categoryData.specificationTemplate as StoreCategoryMappingCandidate["specificationTemplate"]
      : [],
  };
  const brandId = String(payload.brand || "").trim();
  const brandSnapshot = brandId ? await transaction.get(db.collection("brands").doc(brandId)) : null;
  const brands = brandSnapshot?.exists
    ? [{ id: brandSnapshot.id, name: String((brandSnapshot.data() || {}).name || brandSnapshot.id), isActive: (brandSnapshot.data() || {}).isActive !== false }]
    : [];
  const computedErrors = validateSupplierProductForApproval(
    buildReviewValidationPayload(current, payload),
    [category],
    brands,
  );
  const previous = asRecord(current.productValidation);
  const lowStockRecord = {
    ...current,
    sourceId: current.sourceId || current.supplierSourceId || asRecord(current.supplierSnapshot).sourceId,
    productPayload: payload,
  };
  const lowStockHold = supplierReviewRecordIsLowStockHold(lowStockRecord as never);
  const diagnosticErrors = [
    currentManagedMediaError(current, payload),
    ...(lowStockHold ? [lowSupplierStockValidationError()] : []),
  ].filter((error): error is Record<string, unknown> => Boolean(error));
  const errors = [...computedErrors, ...diagnosticErrors].filter((error, index, entries) => (
    entries.findIndex((candidate) => validationErrorKey(candidate as Record<string, unknown>) === validationErrorKey(error as Record<string, unknown>)) === index
  ));
  const missingFields = [...new Set(errors.map((error) => String((error as Record<string, unknown>).field || "").trim()).filter(Boolean))];
  const productValidation: Record<string, unknown> = {
    ...previous,
    readyToPublish: !lowStockHold && errors.length === 0 && missingFields.length === 0,
    missingFields,
    errors,
  };
  if (Object.hasOwn(previous, "warnings") || currentImportWarnings(previous, payload).length > 0) {
    productValidation.warnings = currentImportWarnings(previous, payload);
  }
  if (Object.hasOwn(previous, "lowStockHold") || lowStockHold) productValidation.lowStockHold = lowStockHold;
  return productValidation;
};

const validateCanonicalTaxonomy = async (
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  categoryId: string,
  subcategoryId: string,
): Promise<FirebaseFirestore.DocumentSnapshot> => {
  const categorySnapshot = await transaction.get(db.collection("categories").doc(categoryId));
  if (!categorySnapshot.exists || !isCanonicalActiveCategory(categorySnapshot.data() as { isActive?: boolean; taxonomyCandidate?: boolean } | undefined)) {
    throw new ApiError("Select an active canonical Zyro category.", 422);
  }
  const category = categorySnapshot.data() || {};
  const subcategories = Array.isArray(category.subcategories) ? category.subcategories : [];
  const activeSubcategories = subcategories.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).isActive !== false
  )) as Array<Record<string, unknown>>;
  if (activeSubcategories.length > 0 && !activeSubcategories.some((entry) => String(entry.id || "").trim() === subcategoryId)) {
    throw new ApiError("Select an active subcategory belonging to the category.", 422);
  }
  if (subcategoryId && !activeSubcategories.some((entry) => String(entry.id || "").trim() === subcategoryId)) {
    throw new ApiError("Select an active subcategory belonging to the category.", 422);
  }
  return categorySnapshot;
};

export async function saveSupplierReviewDraft(
  db: Firestore,
  queueItemId: string,
  input: SupplierReviewDraftInput,
  reviewer: SupplierReviewDraftReviewer,
): Promise<{ queueItemId: string; item: Record<string, unknown> & { id: string } }> {
  const reference = db.collection("supplier_review_queue").doc(queueItemId);
  let updatedRecord: Record<string, unknown> | null = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new ApiError("Supplier review item could not be found.", 404);
    const current = snapshot.data() || {};
    const queueState = String(current.queueState || "").trim().toLowerCase();
    const status = String(current.status || current.reviewStatus || "").trim().toLowerCase();
    if (!(queueState === "review_pending" || (!queueState && status === "pending"))) {
      throw new ApiError("Only a pending supplier review item can save a draft.", 409);
    }
    const currentRevision = String(current.supplierOfferPendingRevision || "").trim();
    if (!currentRevision || currentRevision !== input.expectedPendingRevision) {
      throw new ApiError("This supplier review changed after it was opened. Reload before saving.", 409);
    }
    const currentUpdatedAt = timestampString(current.updatedAt);
    if (!currentUpdatedAt || currentUpdatedAt !== input.expectedUpdatedAt) {
      throw new ApiError("This supplier review changed after it was opened. Reload before saving.", 409);
    }

    const categorySnapshot = await validateCanonicalTaxonomy(transaction, db, input.categoryId, input.subcategoryId);
    const payload = asRecord(current.productPayload);
    const now = new Date().toISOString();
    const ownership = taxonomyOwnership(payload.supplierFieldOwnership, reviewer, now);
    const nextPayload = {
      ...payload,
      category: input.categoryId,
      subcategory: input.subcategoryId,
      supplierFieldOwnership: ownership,
    };
    const productValidation = await recomputeProductValidation(transaction, db, current, nextPayload, categorySnapshot);
    updatedRecord = {
      ...current,
      id: queueItemId,
      productPayload: nextPayload,
      productValidation,
      updatedAt: now,
    };
    transaction.update(reference, {
      productPayload: nextPayload,
      productValidation,
      updatedAt: now,
      ...buildSupplierReviewBusinessQueueProjection({
        ...current,
        productPayload: nextPayload,
        productValidation,
        updatedAt: now,
      }),
    });
  });

  if (!updatedRecord) throw new ApiError("Supplier review draft could not be saved.", 500);
  const [item] = await decorateSupplierReviewQueueAdminMedia([updatedRecord as Record<string, unknown> & { id: string }]);
  return { queueItemId, item: item as Record<string, unknown> & { id: string } };
}
