import { RawA2ZProduct } from "./a2z/types";
import { isDeepStrictEqual } from "node:util";
import {
  CanonicalSupplierFieldDefinition,
  CanonicalSupplierFieldId,
  SUPPLIER_FIELD_MANIFEST,
  SupplierFieldAuditRepresentation,
  SupplierFieldDestination,
  SupplierFieldEmptyBehavior,
  SupplierFieldSyncGroup,
} from "./supplierFieldManifest";

export interface SupplierImportValidationWarning {
  field: string;
  code: string;
  message: string;
  severity: "warning";
}

const FIELD_MANIFEST: readonly CanonicalSupplierFieldDefinition[] = SUPPLIER_FIELD_MANIFEST;
const CUSTOMER_CATALOG_FIELDS = FIELD_MANIFEST.filter((field) => field.catalogField);
const SUPPLIER_METADATA_FIELDS = FIELD_MANIFEST.filter((field) => field.metadataField);

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

export interface SupplierFieldChange {
  field: CanonicalSupplierFieldId;
  label: string;
  auditKey: string;
  auditRepresentation: SupplierFieldAuditRepresentation;
  before: unknown;
  after: unknown;
  changeType: "added" | "changed" | "invalid_removal";
  syncGroup: SupplierFieldSyncGroup;
  emptyBehavior: SupplierFieldEmptyBehavior;
  adminEditable: boolean;
  destinations: readonly SupplierFieldDestination[];
}

export type SupplierProductComparisonStatus = "NEW_PRODUCT" | "PRICE_CHANGED" | "STOCK_CHANGED" | "DESCRIPTION_CHANGED" | "IMAGE_CHANGED" | "UNCHANGED";

export interface SupplierProductComparison {
  status: SupplierProductComparisonStatus;
  changedFields: string[];
  fieldChanges: SupplierFieldChange[];
}

const pathValue = (record: Readonly<Record<string, unknown>>, path: string): unknown => {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const existingFieldValue = (
  existing: Readonly<Record<string, unknown>>,
  field: CanonicalSupplierFieldDefinition,
): unknown => {
  for (const path of field.existingPaths) {
    const value = pathValue(existing, path);
    if (hasValue(value)) return value;
  }
  return undefined;
};

const normalizedSupplierValue = (
  product: RawA2ZProduct,
  field: CanonicalSupplierFieldDefinition,
): unknown => product[field.normalizedField];

const canonicalize = (value: unknown, comparison: CanonicalSupplierFieldDefinition["comparison"]): unknown => {
  if (comparison === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (comparison === "text") return typeof value === "string" ? value.trim() : value;
  if (comparison === "boolean") return Boolean(value);
  if (comparison === "unordered_list") {
    const values = Array.isArray(value) ? value : [];
    return values.map((entry) => canonicalize(entry, "deep")).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, "deep"));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry, "deep")]));
  }
  return value ?? null;
};

const valuesEqual = (
  left: unknown,
  right: unknown,
  comparison: CanonicalSupplierFieldDefinition["comparison"],
): boolean => isDeepStrictEqual(canonicalize(left, comparison), canonicalize(right, comparison));

const fieldWasProvided = (product: RawA2ZProduct, field: CanonicalSupplierFieldDefinition): boolean => {
  const providedFields = new Set(product.providedFields || []);
  return providedFields.has(field.presenceField || field.id)
    || (field.id === "mediaGallery" && product.mediaGallery.length > 0)
    || (field.id === "extraAttributes" && hasValue(product.extraAttributes));
};

/** Returns one complete, serializable before/after record per changed supplier field. */
export function detectSupplierProductFieldChanges(
  product: RawA2ZProduct,
  existing: Readonly<Record<string, unknown>>,
): SupplierFieldChange[] {
  const changes: SupplierFieldChange[] = [];
  for (const field of FIELD_MANIFEST) {
    if (!fieldWasProvided(product, field)) continue;
    const incoming = normalizedSupplierValue(product, field);
    const current = existingFieldValue(existing, field);
    if (!hasValue(incoming)) {
      if (field.emptyBehavior === "reject" && hasValue(current)) {
        changes.push({
          field: field.id as CanonicalSupplierFieldId,
          label: field.audit.label,
          auditKey: field.audit.key,
          auditRepresentation: field.audit.representation,
          before: current,
          after: null,
          changeType: "invalid_removal",
          syncGroup: field.syncGroup,
          emptyBehavior: field.emptyBehavior,
          adminEditable: field.adminEditable,
          destinations: field.destinations,
        });
      }
      continue;
    }
    if (valuesEqual(incoming, current, field.comparison)) continue;
    const label = field.id === "mediaGallery"
      && Array.isArray(incoming)
      && Array.isArray(current)
      && incoming[0] !== current[0]
      ? "Primary Image"
      : field.audit.label;
    changes.push({
      field: field.id as CanonicalSupplierFieldId,
      label,
      auditKey: field.audit.key,
      auditRepresentation: field.audit.representation,
      before: current ?? null,
      after: incoming,
      changeType: hasValue(current) ? "changed" : "added",
      syncGroup: field.syncGroup,
      emptyBehavior: field.emptyBehavior,
      adminEditable: field.adminEditable,
      destinations: field.destinations,
    });
  }
  return changes;
}

export function buildSupplierProductComparison(
  product: RawA2ZProduct,
  existing?: Readonly<Record<string, unknown>>,
): SupplierProductComparison {
  const fieldChanges = detectSupplierProductFieldChanges(product, existing || {});
  const changedFields = [...new Set(fieldChanges.map((change) => change.label))];
  if (!existing) return { status: "NEW_PRODUCT", changedFields, fieldChanges };
  if (fieldChanges.length === 0) return { status: "UNCHANGED", changedFields, fieldChanges };
  const groups = new Set(fieldChanges.map((change) => change.syncGroup));
  if (groups.has("pricing")) return { status: "PRICE_CHANGED", changedFields, fieldChanges };
  if (groups.has("inventory")) return { status: "STOCK_CHANGED", changedFields, fieldChanges };
  if (groups.has("media")) return { status: "IMAGE_CHANGED", changedFields, fieldChanges };
  return { status: "DESCRIPTION_CHANGED", changedFields, fieldChanges };
}

/** Detects supplied metadata changes without interpreting absent fields as deletes. */
export function detectSupplierProductDetailChanges(
  product: RawA2ZProduct,
  existing: Readonly<Record<string, unknown>>,
): string[] {
  const coreFields = new Set<CanonicalSupplierFieldId>([
    "sku", "title", "longDescription", "mediaGallery", "price", "comparePrice", "costPrice", "stock",
  ]);
  return [...new Set(detectSupplierProductFieldChanges(product, existing)
    .filter((change) => !coreFields.has(change.field))
    .map((change) => change.label))];
}

/**
 * Keeps optional customer-facing supplier fields additive. Missing or empty
 * connector values never erase an existing approved catalogue value.
 */
export function mergeSupplierCatalogDetails(
  product: RawA2ZProduct,
  existing: Readonly<Record<string, unknown>> = {},
  acceptSupplierValues: boolean | ReadonlySet<string> = true,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const definition of CUSTOMER_CATALOG_FIELDS) {
    const field = definition.catalogField;
    if (!field) continue;
    const supplierValue = product[field];
    const currentValue = existing[field];
    const accepted = acceptSupplierValues === true
      || (acceptSupplierValues !== false && acceptSupplierValues.has(definition.id));
    if (accepted && hasValue(supplierValue)) merged[field] = supplierValue;
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
  acceptSupplierValues: boolean | ReadonlySet<string> = true,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  const providedFields = new Set(product.providedFields || []);
  for (const definition of SUPPLIER_METADATA_FIELDS) {
    const field = definition.metadataField;
    if (!field) continue;
    const directValue = product[field];
    const value = hasValue(directValue) ? directValue : product[definition.normalizedField];
    const presenceField = definition.presenceField || definition.id;
    const explicitlyProvided = providedFields.has(presenceField);
    const accepted = acceptSupplierValues === true
      || (acceptSupplierValues !== false && acceptSupplierValues.has(definition.id));
    if (accepted && explicitlyProvided && hasValue(value)) merged[field] = value;
  }
  const acceptsExtraAttributes = acceptSupplierValues === true
    || (acceptSupplierValues !== false && acceptSupplierValues.has("extraAttributes"));
  if (acceptsExtraAttributes && product.extraAttributes && Object.keys(product.extraAttributes).length > 0) {
    merged.extraAttributes = {
      ...asRecord(existing.extraAttributes),
      ...product.extraAttributes,
    };
  }
  const existingProvidedFields = Array.isArray(existing.providedFields)
    ? existing.providedFields.filter((field): field is string => typeof field === "string")
    : [];
  const acceptedProvidedFields = acceptSupplierValues === true
    ? [...providedFields]
    : acceptSupplierValues === false
      ? []
      : [...providedFields].filter((field) => acceptSupplierValues.has(field));
  const mergedProvidedFields = [...new Set([...existingProvidedFields, ...acceptedProvidedFields])];
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
