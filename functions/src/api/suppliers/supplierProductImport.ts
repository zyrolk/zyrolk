import { RawA2ZProduct } from "./a2z/types";
import { isDeepStrictEqual } from "node:util";

export interface SupplierImportValidationWarning {
  field: string;
  code: string;
  message: string;
  severity: "warning";
}

const CUSTOMER_CATALOG_FIELDS: ReadonlyArray<keyof RawA2ZProduct> = [
  "shortDescription",
  "manufacturer",
  "model",
  "tags",
  "keywords",
  "productType",
  "collection",
  "attributes",
  "variants",
  "options",
  "features",
  "dimensions",
  "weight",
  "packageSize",
  "shippingClass",
  "warranty",
  "countryOfOrigin",
  "videoUrls",
  "currency",
  "tax",
  "availability",
  "slug",
  "metaDescription",
];

const SUPPLIER_METADATA_FIELDS: ReadonlyArray<keyof RawA2ZProduct> = [
  "supplierProductId",
  "sku",
  "barcode",
  "title",
  "shortDescription",
  "longDescription",
  "brand",
  "manufacturer",
  "model",
  "categoryHierarchy",
  "supplierCategory",
  "supplierSubcategory",
  "tags",
  "keywords",
  "productType",
  "collection",
  "attributes",
  "variants",
  "options",
  "specifications",
  "features",
  "dimensions",
  "weight",
  "packageSize",
  "shippingClass",
  "warranty",
  "countryOfOrigin",
  "mediaGallery",
  "videoUrls",
  "price",
  "comparePrice",
  "costPrice",
  "currency",
  "tax",
  "discount",
  "inventoryLevel",
  "availability",
  "leadTime",
  "minimumOrderQuantity",
  "maximumOrderQuantity",
  "visibility",
  "status",
  "lastUpdated",
  "createdDate",
  "slug",
  "metaDescription",
];

const hasValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
};

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const hasCollectionValues = (value: unknown): boolean => hasValue(value);

const DETAIL_CHANGE_FIELDS: ReadonlyArray<{ field: keyof RawA2ZProduct; label: string; catalogField?: string }> = [
  { field: "supplierProductId", label: "Supplier Product ID" },
  { field: "barcode", label: "Barcode", catalogField: "barcode" },
  { field: "shortDescription", label: "Short Description", catalogField: "shortDescription" },
  { field: "brand", label: "Supplier Brand" },
  { field: "manufacturer", label: "Manufacturer", catalogField: "manufacturer" },
  { field: "model", label: "Model", catalogField: "model" },
  { field: "categoryHierarchy", label: "Supplier Category" },
  { field: "supplierCategory", label: "Supplier Category" },
  { field: "supplierSubcategory", label: "Supplier Subcategory" },
  { field: "tags", label: "Tags", catalogField: "tags" },
  { field: "keywords", label: "Keywords", catalogField: "keywords" },
  { field: "productType", label: "Product Type", catalogField: "productType" },
  { field: "collection", label: "Collection", catalogField: "collection" },
  { field: "attributes", label: "Attributes", catalogField: "attributes" },
  { field: "variants", label: "Variants", catalogField: "variants" },
  { field: "options", label: "Options", catalogField: "options" },
  { field: "specifications", label: "Specifications" },
  { field: "features", label: "Features", catalogField: "features" },
  { field: "dimensions", label: "Dimensions", catalogField: "dimensions" },
  { field: "weight", label: "Weight", catalogField: "weight" },
  { field: "packageSize", label: "Package Size", catalogField: "packageSize" },
  { field: "shippingClass", label: "Shipping Class", catalogField: "shippingClass" },
  { field: "warranty", label: "Warranty", catalogField: "warranty" },
  { field: "countryOfOrigin", label: "Country of Origin", catalogField: "countryOfOrigin" },
  { field: "videoUrls", label: "Videos", catalogField: "videoUrls" },
  { field: "currency", label: "Currency", catalogField: "currency" },
  { field: "tax", label: "Tax", catalogField: "tax" },
  { field: "discount", label: "Supplier Discount" },
  { field: "availability", label: "Availability", catalogField: "availability" },
  { field: "leadTime", label: "Lead Time" },
  { field: "minimumOrderQuantity", label: "Minimum Order Quantity" },
  { field: "maximumOrderQuantity", label: "Maximum Order Quantity" },
  { field: "visibility", label: "Supplier Visibility" },
  { field: "status", label: "Supplier Status" },
  { field: "slug", label: "SEO Slug", catalogField: "slug" },
  { field: "metaDescription", label: "Meta Description", catalogField: "metaDescription" },
];

/** Detects supplied metadata changes without interpreting absent fields as deletes. */
export function detectSupplierProductDetailChanges(
  product: RawA2ZProduct,
  existing: Readonly<Record<string, unknown>>,
): string[] {
  const providedFields = new Set(product.providedFields || []);
  const existingMetadata = asRecord(existing.supplierMetadata);
  const changes: string[] = [];
  for (const descriptor of DETAIL_CHANGE_FIELDS) {
    if (!providedFields.has(String(descriptor.field))) continue;
    const incoming = product[descriptor.field];
    if (!hasValue(incoming)) continue;
    const current = descriptor.catalogField && hasValue(existing[descriptor.catalogField])
      ? existing[descriptor.catalogField]
      : existingMetadata[descriptor.field];
    if (!isDeepStrictEqual(incoming, current)) changes.push(descriptor.label);
  }
  if (product.extraAttributes && !isDeepStrictEqual(product.extraAttributes, asRecord(existingMetadata.extraAttributes))) {
    changes.push("Extra Attributes");
  }
  return [...new Set(changes)];
}

/**
 * Keeps optional customer-facing supplier fields additive. Missing or empty
 * connector values never erase an existing approved catalogue value.
 */
export function mergeSupplierCatalogDetails(
  product: RawA2ZProduct,
  existing: Readonly<Record<string, unknown>> = {},
  acceptSupplierValues = true,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of CUSTOMER_CATALOG_FIELDS) {
    const supplierValue = product[field];
    const currentValue = existing[field];
    if (acceptSupplierValues && hasValue(supplierValue)) merged[field] = supplierValue;
    else if (hasValue(currentValue)) merged[field] = currentValue;
  }
  return merged;
}

/**
 * Builds the private supplier metadata snapshot. It is deliberately separate
 * from the public product document and merges field-by-field for approved
 * products so sparse connector updates cannot destroy earlier supplier data.
 */
export function mergeSupplierProductMetadata(
  product: RawA2ZProduct,
  existing: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  const providedFields = new Set(product.providedFields || []);
  for (const field of SUPPLIER_METADATA_FIELDS) {
    const value = product[field];
    const presenceField = field === "inventoryLevel" ? "stock" : String(field);
    const explicitlyProvided = providedFields.has(presenceField);
    if ((explicitlyProvided || field === "sku" || field === "title") && hasValue(value)) merged[field] = value;
  }
  if (product.extraAttributes && Object.keys(product.extraAttributes).length > 0) {
    merged.extraAttributes = {
      ...asRecord(existing.extraAttributes),
      ...product.extraAttributes,
    };
  }
  const existingProvidedFields = Array.isArray(existing.providedFields)
    ? existing.providedFields.filter((field): field is string => typeof field === "string")
    : [];
  const mergedProvidedFields = [...new Set([...existingProvidedFields, ...providedFields])];
  if (mergedProvidedFields.length > 0) merged.providedFields = mergedProvidedFields;
  return merged;
}

export function buildSupplierImportWarnings(
  product: RawA2ZProduct,
  productPayload: Readonly<Record<string, unknown>>,
): SupplierImportValidationWarning[] {
  const warnings: SupplierImportValidationWarning[] = [];
  const add = (field: string, code: string, message: string): void => {
    warnings.push({ field, code, message, severity: "warning" });
  };
  const providedFields = new Set(product.providedFields || []);
  const specifications = asRecord(product.specifications);
  const payloadSpecs = asRecord(productPayload.specs);
  const mappedBrand = String(productPayload.brand || "").trim();
  const mappedCategory = String(productPayload.category || "").trim();

  if (!Array.isArray(product.mediaGallery) || product.mediaGallery.length === 0) {
    add("images", "missing_images", "The supplier did not provide a usable product image.");
  }
  if (!mappedBrand) {
    add("brand", "missing_brand", String(product.brand || specifications.brand || specifications.Brand || "").trim()
      ? "The supplier brand still requires an approved registry mapping."
      : "The supplier did not provide a brand.");
  }
  if (!mappedCategory) {
    add("category", "missing_category", (product.categoryHierarchy || []).some((category) => String(category || "").trim())
      ? "The supplier category still requires an approved category mapping."
      : "The supplier did not provide a category.");
  }
  if (!Number.isFinite(Number(productPayload.price)) || Number(productPayload.price) <= 0) {
    add("price", "missing_price", "A valid selling price is not available.");
  }
  if (!providedFields.has("stock")) {
    add("stock", "missing_stock", "The supplier did not provide an inventory quantity.");
  } else if (!Number.isInteger(product.inventoryLevel) || product.inventoryLevel < 0) {
    add("stock", "invalid_stock", "The supplier inventory quantity is invalid.");
  }
  if (Object.keys(specifications).length === 0 && Object.keys(payloadSpecs).length === 0) {
    add("specifications", "missing_specifications", "The supplier did not provide product specifications.");
  }

  const hasOptions = hasCollectionValues(product.options);
  const hasVariants = hasCollectionValues(product.variants);
  if (hasOptions !== hasVariants) {
    add("variants", "missing_variant_data", "Variant options and variant records are incomplete.");
  }
  return warnings;
}
