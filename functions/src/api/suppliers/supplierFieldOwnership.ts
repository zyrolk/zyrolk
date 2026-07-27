import { SUPPLIER_FIELD_MANIFEST } from "./supplierFieldManifest";

export type SupplierProductFieldOwner = "admin" | "supplier";

export interface SupplierProductFieldOwnershipEntry {
  owner: SupplierProductFieldOwner;
  sourceId: string | null;
  updatedAt: unknown;
  updatedBy: string;
  reason: "admin_product_edit" | "review_decision" | "supplier_import" | "legacy_default";
}

export type SupplierProductFieldOwnership = Record<string, SupplierProductFieldOwnershipEntry>;
export type SupplierProductFieldOwnershipDecision = Record<string, SupplierProductFieldOwner>;

const ADMIN_ONLY_PRODUCT_FIELDS = [
  "keyFeatures",
  "whatsIncluded",
  "isNew",
  "isFeatured",
  "isBestSeller",
  "isActive",
] as const;

// Commercial values live in product_private, but administrators still need
// durable ownership when they intentionally override supplier pricing during
// Product Review.
const ADMIN_EDITABLE_COMMERCIAL_FIELDS = ["costPrice", "marketPrice"] as const;

export const SUPPLIER_PRODUCT_OWNERSHIP_FIELDS = [...new Set([
  ...SUPPLIER_FIELD_MANIFEST.flatMap((field) => field.destinations
    .filter((destination) => destination.scope === "public" && field.adminEditable)
    .map((destination) => destination.path)),
  ...ADMIN_ONLY_PRODUCT_FIELDS,
  ...ADMIN_EDITABLE_COMMERCIAL_FIELDS,
])].sort();

const ownershipFieldSet = new Set<string>(SUPPLIER_PRODUCT_OWNERSHIP_FIELDS);

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const cleanSourceId = (value: unknown): string | null => typeof value === "string" && value.trim()
  ? value.trim().slice(0, 160)
  : null;

const parseOwner = (value: unknown): SupplierProductFieldOwner | null => value === "admin" || value === "supplier"
  ? value
  : null;

export function parseSupplierProductFieldOwnership(value: unknown): SupplierProductFieldOwnership {
  const result: SupplierProductFieldOwnership = {};
  for (const [field, rawEntry] of Object.entries(asRecord(value))) {
    if (!ownershipFieldSet.has(field)) continue;
    const entry = asRecord(rawEntry);
    const owner = parseOwner(typeof rawEntry === "string" ? rawEntry : entry.owner);
    if (!owner) continue;
    result[field] = {
      owner,
      sourceId: cleanSourceId(entry.sourceId),
      updatedAt: entry.updatedAt ?? null,
      updatedBy: typeof entry.updatedBy === "string" ? entry.updatedBy.slice(0, 160) : "legacy",
      reason: entry.reason === "admin_product_edit"
        || entry.reason === "review_decision"
        || entry.reason === "supplier_import"
        || entry.reason === "legacy_default"
        ? entry.reason
        : "legacy_default",
    };
  }
  return result;
}

export function parseSupplierProductFieldOwnershipDecision(value: unknown): SupplierProductFieldOwnershipDecision {
  const result: SupplierProductFieldOwnershipDecision = {};
  for (const [field, rawOwner] of Object.entries(asRecord(value))) {
    if (!ownershipFieldSet.has(field)) throw new Error(`Product field ownership is invalid for ${field}.`);
    const owner = parseOwner(rawOwner);
    if (!owner) throw new Error(`Product field ownership is invalid for ${field}.`);
    result[field] = owner;
  }
  return result;
}

export function parseSupplierProductEditedFields(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SUPPLIER_PRODUCT_OWNERSHIP_FIELDS.length) {
    throw new Error("Edited product fields are invalid.");
  }
  const result = value.map((field) => {
    if (typeof field !== "string" || !ownershipFieldSet.has(field)) {
      throw new Error("Edited product fields are invalid.");
    }
    return field;
  });
  return [...new Set(result)];
}

const hasOwn = (value: Record<string, unknown>, field: string): boolean => Object.prototype.hasOwnProperty.call(value, field);

export interface ApplySupplierProductFieldOwnershipInput {
  proposedProduct: Record<string, unknown>;
  currentProduct?: Record<string, unknown>;
  existingOwnership?: unknown;
  requestedOwnership?: SupplierProductFieldOwnershipDecision;
  editedFields?: readonly string[];
  sourceId?: string;
  reviewerId: string;
  timestamp: unknown;
}

export function applySupplierProductFieldOwnership({
  proposedProduct,
  currentProduct,
  existingOwnership,
  requestedOwnership = {},
  editedFields = [],
  sourceId,
  reviewerId,
  timestamp,
}: ApplySupplierProductFieldOwnershipInput): {
  product: Record<string, unknown>;
  ownership: SupplierProductFieldOwnership;
} {
  const product = { ...proposedProduct };
  const existing = parseSupplierProductFieldOwnership(existingOwnership);
  const ownership: SupplierProductFieldOwnership = { ...existing };
  const edited = new Set(editedFields);
  const productExists = Boolean(currentProduct);

  for (const field of SUPPLIER_PRODUCT_OWNERSHIP_FIELDS) {
    const requested = requestedOwnership[field];
    const previous = existing[field];
    const owner = requested || previous?.owner || (productExists ? "admin" : ADMIN_ONLY_PRODUCT_FIELDS.includes(field as typeof ADMIN_ONLY_PRODUCT_FIELDS[number]) ? "admin" : "supplier");
    const isRelevant = requested !== undefined
      || previous !== undefined
      || edited.has(field)
      || hasOwn(proposedProduct, field)
      || Boolean(currentProduct && hasOwn(currentProduct, field));
    if (!isRelevant) continue;

    if (owner === "admin" && productExists && !edited.has(field)) {
      if (hasOwn(currentProduct!, field)) product[field] = currentProduct![field];
      else delete product[field];
    }

    const changed = previous?.owner !== owner || requested !== undefined || edited.has(field);
    ownership[field] = changed ? {
      owner,
      sourceId: owner === "supplier" ? cleanSourceId(sourceId) : null,
      updatedAt: timestamp,
      updatedBy: reviewerId.slice(0, 160),
      reason: productExists ? "review_decision" : owner === "supplier" ? "supplier_import" : "review_decision",
    } : previous;
  }

  return { product, ownership };
}
