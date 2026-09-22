import { Firestore, FieldValue } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  normalizeSupplierMappingValue,
  hasSupplierSubcategoryBinding,
  supplierChildMappingDocumentId,
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
  supplierSubcategory?: string;
  supplierSubcategoryId?: string;
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
  ...(text(value.supplierSubcategory) ? { supplierSubcategory: text(value.supplierSubcategory) } : {}),
  ...(text(value.normalizedSupplierSubcategory) ? { normalizedSupplierSubcategory: text(value.normalizedSupplierSubcategory) } : {}),
  ...(text(value.supplierSubcategoryId) ? { supplierSubcategoryId: text(value.supplierSubcategoryId) } : {}),
  ...(value.mappingScope === "child" || value.mappingScope === "parent" ? { mappingScope: value.mappingScope } : {}),
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
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId)
      || left.normalizedCategory.localeCompare(right.normalizedCategory)
      || left.id.localeCompare(right.id))
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
  const supplierSubcategory = text(value.supplierSubcategory);
  const normalizedSupplierSubcategory = normalizeSupplierMappingValue(supplierSubcategory);
  if (value.supplierSubcategory !== undefined && typeof value.supplierSubcategory !== "string") {
    throw new ApiError("The supplier subcategory is invalid.", 400);
  }
  if (value.supplierSubcategoryId !== undefined && typeof value.supplierSubcategoryId !== "string") {
    throw new ApiError("The supplier subcategory ID is invalid.", 400);
  }
  const supplierSubcategoryId = text(value.supplierSubcategoryId);
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
  if (targetSubcategoryId && !normalizedSupplierSubcategory && !supplierSubcategoryId) {
    throw new ApiError("A supplier subcategory binding is required for a reusable target subcategory.", 400);
  }
  const categoryData = categorySnapshot.data() || {};
  const activeSubcategories = Array.isArray(categoryData.subcategories)
    ? categoryData.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object") && (entry as Record<string, unknown>).isActive !== false)
    : [];
  if (activeSubcategories.length > 0 && !targetSubcategoryId && (normalizedSupplierSubcategory || supplierSubcategoryId)) {
    throw new ApiError("Select an active subcategory for the supplied supplier child taxonomy.", 400);
  }
  const targetSubcategory = targetSubcategoryId
    ? activeSubcategories.find((entry) => String(entry.id || "") === targetSubcategoryId)
    : undefined;
  if (targetSubcategoryId && !targetSubcategory) {
    throw new ApiError("The target subcategory does not belong to the selected active category.", 400);
  }

  const parentMappingReference = db.collection("supplier_category_mappings").doc(supplierMappingDocumentId(sourceId, normalizedCategory));
  const childMappingReference = targetSubcategoryId && (normalizedSupplierSubcategory || supplierSubcategoryId)
    ? db.collection("supplier_category_mappings").doc(supplierChildMappingDocumentId(
      sourceId,
      normalizedCategory,
      supplierSubcategory,
      supplierSubcategoryId,
    ))
    : null;
  const mapping = await db.runTransaction(async (transaction) => {
    const parentSnapshot = await transaction.get(parentMappingReference);
    const currentSnapshot = childMappingReference ? await transaction.get(childMappingReference) : parentSnapshot;
    const previous = currentSnapshot.exists ? currentSnapshot.data() || {} : {};
    const next = {
      sourceId,
      supplierCategory,
      normalizedCategory,
      targetCategoryId,
      targetSubcategoryId,
      mappingScope: childMappingReference ? "child" as const : "parent" as const,
      confidence: 100,
      mappingType: "manual",
      version: Math.max(0, Number(previous.version) || 0) + 1,
      updatedBy: actor.uid,
      updatedAt: FieldValue.serverTimestamp(),
      ...(targetSubcategoryId ? {
        ...(supplierSubcategory ? { supplierSubcategory } : {}),
        ...(normalizedSupplierSubcategory ? { normalizedSupplierSubcategory } : {}),
        ...(supplierSubcategoryId ? { supplierSubcategoryId } : {}),
      } : {}),
    };
    if (childMappingReference) {
      const previousParent = parentSnapshot.exists ? parentSnapshot.data() || {} : {};
      const parentHasLegacyBinding = hasSupplierSubcategoryBinding(previousParent);
      transaction.set(parentMappingReference, {
        sourceId,
        supplierCategory,
        normalizedCategory,
        targetCategoryId,
        mappingScope: "parent" as const,
        ...(parentHasLegacyBinding ? {
          targetSubcategoryId: text(previousParent.targetSubcategoryId),
          ...(text(previousParent.supplierSubcategory) ? { supplierSubcategory: text(previousParent.supplierSubcategory) } : {}),
          ...(text(previousParent.normalizedSupplierSubcategory) ? { normalizedSupplierSubcategory: text(previousParent.normalizedSupplierSubcategory) } : {}),
          ...(text(previousParent.supplierSubcategoryId) ? { supplierSubcategoryId: text(previousParent.supplierSubcategoryId) } : {}),
        } : { targetSubcategoryId: "" }),
        confidence: 100,
        mappingType: "manual",
        version: Math.max(0, Number(previousParent.version) || 0) + 1,
        updatedBy: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(childMappingReference, next, { merge: true });
    } else {
      const previousParent = parentSnapshot.exists ? parentSnapshot.data() || {} : {};
      const parentHasLegacyBinding = hasSupplierSubcategoryBinding(previousParent);
      transaction.set(parentMappingReference, parentHasLegacyBinding ? {
        ...next,
        targetSubcategoryId: text(previousParent.targetSubcategoryId),
        ...(text(previousParent.supplierSubcategory) ? { supplierSubcategory: text(previousParent.supplierSubcategory) } : {}),
        ...(text(previousParent.normalizedSupplierSubcategory) ? { normalizedSupplierSubcategory: text(previousParent.normalizedSupplierSubcategory) } : {}),
        ...(text(previousParent.supplierSubcategoryId) ? { supplierSubcategoryId: text(previousParent.supplierSubcategoryId) } : {}),
      } : next, { merge: true });
    }
    const mappingReference = childMappingReference || parentMappingReference;
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
    return { id: mappingReference.id, value: next };
  });
  return projectMapping(mapping.id, mapping.value as Record<string, unknown>);
}
