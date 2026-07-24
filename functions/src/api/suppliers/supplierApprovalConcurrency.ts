import { createHash } from "node:crypto";

export const SUPPLIER_APPROVAL_PROTECTED_FIELDS = [
  "title",
  "description",
  "images",
  "category",
  "brand",
  "specifications",
  "price",
  "comparePrice",
  "visibility",
  "supplierDetails",
] as const;

export type SupplierApprovalProtectedField = typeof SUPPLIER_APPROVAL_PROTECTED_FIELDS[number];

export interface SupplierProductApprovalBaseline {
  productId: string;
  exists: boolean;
  version: string;
  capturedAt: string;
  stockAtCapture: number;
  protectedValues: Record<SupplierApprovalProtectedField, unknown>;
}

export interface SupplierApprovalConflict {
  reason: "missing_product_baseline" | "product_created_after_queue" | "product_deleted_after_queue" | "product_changed_after_queue";
  changedFields: SupplierApprovalProtectedField[];
  previousVersion: string;
  currentVersion: string;
  oldValues: Partial<Record<SupplierApprovalProtectedField, unknown>>;
  newValues: Partial<Record<SupplierApprovalProtectedField, unknown>>;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const finiteStock = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const normalizeImages = (product: Record<string, unknown>): string[] => {
  const values = Array.isArray(product.imageUrls) ? product.imageUrls : [];
  const images = [product.imageUrl, ...values]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(images)];
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value ?? null;
};

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

export function getSupplierApprovalProtectedValues(product: Record<string, unknown> | undefined): Record<SupplierApprovalProtectedField, unknown> {
  const data = product || {};
  const specs = asRecord(data.specs ?? data.specifications);
  const supplierDetailFields = [
    "shortDescription", "manufacturer", "model", "tags", "keywords", "productType", "collection",
    "attributes", "variants", "options", "features", "dimensions", "weight", "packageSize",
    "shippingClass", "warranty", "countryOfOrigin", "videoUrls", "currency", "tax", "availability",
    "slug", "metaDescription", "barcode",
  ];
  const supplierDetails = Object.fromEntries(supplierDetailFields
    .filter((field) => Object.hasOwn(data, field))
    .map((field) => [field, data[field]]));
  return {
    title: data.name ?? data.title ?? "",
    description: data.description ?? data.fullDescription ?? "",
    images: normalizeImages(data),
    category: data.category ?? "",
    brand: data.brand ?? specs.brand ?? specs.Brand ?? "",
    specifications: specs,
    price: data.price ?? data.sellingPrice ?? null,
    comparePrice: data.originalPrice ?? data.comparePrice ?? null,
    visibility: {
      isActive: data.isActive ?? null,
      active: data.active ?? null,
      visible: data.visible ?? null,
      published: data.published ?? null,
    },
    supplierDetails,
  };
}

const productVersion = (productId: string, exists: boolean, values: Record<SupplierApprovalProtectedField, unknown>): string => createHash("sha256")
  .update(JSON.stringify(canonicalize({ productId, exists, values })))
  .digest("hex");

export function buildSupplierProductApprovalBaseline(
  productId: string,
  product: Record<string, unknown> | undefined,
  capturedAt = new Date().toISOString(),
): SupplierProductApprovalBaseline {
  const exists = product !== undefined;
  const protectedValues = getSupplierApprovalProtectedValues(product);
  return {
    productId,
    exists,
    version: productVersion(productId, exists, protectedValues),
    capturedAt,
    stockAtCapture: finiteStock(product?.stock),
    protectedValues,
  };
}

export function parseSupplierProductApprovalBaseline(value: unknown): SupplierProductApprovalBaseline | null {
  const candidate = asRecord(value);
  const protectedValues = asRecord(candidate.protectedValues);
  if (
    typeof candidate.productId !== "string"
    || typeof candidate.exists !== "boolean"
    || typeof candidate.version !== "string"
    || typeof candidate.capturedAt !== "string"
    || !SUPPLIER_APPROVAL_PROTECTED_FIELDS.filter((field) => field !== "supplierDetails").every((field) => Object.hasOwn(protectedValues, field))
  ) return null;
  if (!Object.hasOwn(protectedValues, "supplierDetails")) protectedValues.supplierDetails = {};
  return {
    productId: candidate.productId,
    exists: candidate.exists,
    version: candidate.version,
    capturedAt: candidate.capturedAt,
    stockAtCapture: finiteStock(candidate.stockAtCapture),
    protectedValues: protectedValues as Record<SupplierApprovalProtectedField, unknown>,
  };
}

export function detectSupplierApprovalConflict(
  baseline: SupplierProductApprovalBaseline | null,
  productId: string,
  currentProduct: Record<string, unknown> | undefined,
): SupplierApprovalConflict | null {
  const currentBaseline = buildSupplierProductApprovalBaseline(productId, currentProduct);
  if (!baseline) {
    return {
      reason: "missing_product_baseline",
      changedFields: [...SUPPLIER_APPROVAL_PROTECTED_FIELDS],
      previousVersion: "missing",
      currentVersion: currentBaseline.version,
      oldValues: {},
      newValues: currentBaseline.protectedValues,
    };
  }
  if (!baseline.exists && currentBaseline.exists) {
    return {
      reason: "product_created_after_queue",
      changedFields: [...SUPPLIER_APPROVAL_PROTECTED_FIELDS],
      previousVersion: baseline.version,
      currentVersion: currentBaseline.version,
      oldValues: baseline.protectedValues,
      newValues: currentBaseline.protectedValues,
    };
  }
  if (baseline.exists && !currentBaseline.exists) {
    return {
      reason: "product_deleted_after_queue",
      changedFields: [...SUPPLIER_APPROVAL_PROTECTED_FIELDS],
      previousVersion: baseline.version,
      currentVersion: currentBaseline.version,
      oldValues: baseline.protectedValues,
      newValues: currentBaseline.protectedValues,
    };
  }
  const changedFields = SUPPLIER_APPROVAL_PROTECTED_FIELDS.filter((field) => !equal(
    baseline.protectedValues[field],
    currentBaseline.protectedValues[field],
  ));
  if (changedFields.length === 0) return null;
  return {
    reason: "product_changed_after_queue",
    changedFields,
    previousVersion: baseline.version,
    currentVersion: currentBaseline.version,
    oldValues: Object.fromEntries(changedFields.map((field) => [field, baseline.protectedValues[field]])),
    newValues: Object.fromEntries(changedFields.map((field) => [field, currentBaseline.protectedValues[field]])),
  };
}

/**
 * Applies only the supplier-side stock movement since queue creation. Live stock
 * may already include checkout reservations, pending orders, or admin adjustments.
 */
export function reconcileSupplierApprovalStock(
  baselineStock: unknown,
  currentLiveStock: unknown,
  supplierTargetStock: unknown,
  productExists: boolean,
): number {
  const supplierStock = finiteStock(supplierTargetStock);
  if (!productExists) return supplierStock;
  const supplierDelta = supplierStock - finiteStock(baselineStock);
  return Math.max(0, finiteStock(currentLiveStock) + supplierDelta);
}

export function rebaseSupplierApprovalConflict(
  baseline: SupplierProductApprovalBaseline | null,
  productId: string,
  currentProduct: Record<string, unknown> | undefined,
): SupplierProductApprovalBaseline {
  const rebased = buildSupplierProductApprovalBaseline(productId, currentProduct);
  return baseline ? { ...rebased, stockAtCapture: baseline.stockAtCapture } : rebased;
}
