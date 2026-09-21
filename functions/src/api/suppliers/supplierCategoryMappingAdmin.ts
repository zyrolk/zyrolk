import { Firestore, FieldValue } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  normalizeSupplierMappingValue,
  supplierMappingDocumentId,
  SupplierCategoryMappingRecord,
} from "./supplierProductMapping";

export interface SupplierCategoryMappingAdminActor {
  uid: string;
  email: string;
}

export interface SupplierCategoryMappingAdminInput {
  sourceId: string;
  supplierCategory: string;
  targetCategoryId: string;
  targetSubcategoryId?: string;
}

const text = (value: unknown, max = 160): string => {
  const result = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  return result.length <= max ? result : result.slice(0, max).trim();
};

const projectMapping = (id: string, value: Record<string, unknown>): SupplierCategoryMappingRecord & { id: string } => ({
  id,
  sourceId: text(value.sourceId),
  supplierCategory: text(value.supplierCategory),
  normalizedCategory: text(value.normalizedCategory),
  targetCategoryId: text(value.targetCategoryId),
  targetSubcategoryId: text(value.targetSubcategoryId),
  confidence: Number(value.confidence) || 0,
  mappingType: value.mappingType === "learned" ? "learned" : "manual",
  version: Math.max(0, Number(value.version) || 0),
  updatedBy: text(value.updatedBy),
  updatedAt: value.updatedAt,
});

export async function listSupplierCategoryMappings(
  db: Firestore,
  sourceIdInput?: unknown,
): Promise<Array<SupplierCategoryMappingRecord & { id: string }>> {
  if (sourceIdInput !== undefined && typeof sourceIdInput !== "string") {
    throw new ApiError("The supplier source ID is invalid.", 400);
  }
  const sourceId = text(sourceIdInput);
  if (sourceId && sourceId.includes("/")) throw new ApiError("The supplier source ID is invalid.", 400);
  const snapshot = await db.collection("supplier_category_mappings").limit(1_000).get();
  return snapshot.docs
    .map((document) => projectMapping(document.id, document.data()))
    .filter((mapping) => !sourceId || mapping.sourceId === sourceId)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.normalizedCategory.localeCompare(right.normalizedCategory))
    .slice(0, 1_000);
}

export async function saveSupplierCategoryMapping(
  db: Firestore,
  input: unknown,
  actor: SupplierCategoryMappingAdminActor,
): Promise<SupplierCategoryMappingRecord & { id: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Supplier category mapping is invalid.", 400);
  const value = input as Record<string, unknown>;
  const sourceId = text(value.sourceId);
  const supplierCategory = text(value.supplierCategory);
  const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
  const targetCategoryId = text(value.targetCategoryId);
  if (value.targetSubcategoryId !== undefined && typeof value.targetSubcategoryId !== "string") {
    throw new ApiError("The target subcategory ID is invalid.", 400);
  }
  const targetSubcategoryId = text(value.targetSubcategoryId);
  if (!sourceId || sourceId.includes("/") || !supplierCategory || !normalizedCategory || !targetCategoryId) {
    throw new ApiError("Supplier source, supplier category, and target category are required.", 400);
  }
  if (targetCategoryId.includes("/") || targetSubcategoryId.includes("/")) {
    throw new ApiError("The target category or subcategory ID is invalid.", 400);
  }

  const [sourceSnapshot, categorySnapshot] = await Promise.all([
    db.collection("supplierSources").doc(sourceId).get(),
    db.collection("categories").doc(targetCategoryId).get(),
  ]);
  if (!sourceSnapshot.exists) throw new ApiError("The supplier source was not found.", 404);
  if (!categorySnapshot.exists || categorySnapshot.data()?.isActive === false) {
    throw new ApiError("The target category must be an active canonical category.", 400);
  }
  const categoryData = categorySnapshot.data() || {};
  const activeSubcategories = Array.isArray(categoryData.subcategories)
    ? categoryData.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object") && (entry as Record<string, unknown>).isActive !== false)
    : [];
  const targetSubcategory = targetSubcategoryId
    ? activeSubcategories.find((entry) => String(entry.id || "") === targetSubcategoryId)
    : undefined;
  if (targetSubcategoryId && !targetSubcategory) {
    throw new ApiError("The target subcategory does not belong to the selected active category.", 400);
  }
  if (activeSubcategories.length > 0 && !targetSubcategoryId) {
    throw new ApiError("Select an active subcategory for the selected category.", 400);
  }

  const mappingReference = db.collection("supplier_category_mappings").doc(supplierMappingDocumentId(sourceId, normalizedCategory));
  const mapping = await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(mappingReference);
    const previous = currentSnapshot.exists ? currentSnapshot.data() || {} : {};
    const next = {
      sourceId,
      supplierCategory,
      normalizedCategory,
      targetCategoryId,
      targetSubcategoryId,
      confidence: 100,
      mappingType: "manual",
      version: Math.max(0, Number(previous.version) || 0) + 1,
      updatedBy: actor.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(mappingReference, next, { merge: true });
    const auditReference = db.collection("supplier_mapping_audit").doc();
    transaction.create(auditReference, {
      id: auditReference.id,
      mappingKind: "category",
      mappingId: mappingReference.id,
      sourceId,
      action: "admin_mapping_saved",
      previous: currentSnapshot.exists ? previous : null,
      current: next,
      adminUserId: actor.uid,
      adminEmail: actor.email,
      timestamp: FieldValue.serverTimestamp(),
    });
    return next;
  });
  return projectMapping(mappingReference.id, mapping as Record<string, unknown>);
}
