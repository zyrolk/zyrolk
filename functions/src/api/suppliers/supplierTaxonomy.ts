import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  normalizeSupplierMappingValue,
  SupplierTaxonomyCandidatePlan,
} from "./supplierProductMapping";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const candidateChild = (plan: SupplierTaxonomyCandidatePlan, observedAt: string): Record<string, unknown> => ({
  id: plan.subcategoryId,
  name: plan.supplierSubcategory,
  isActive: false,
  taxonomyCandidate: true,
  taxonomyStatus: "pending",
  supplierTaxonomySourceId: plan.sourceId,
  supplierTaxonomyId: plan.supplierSubcategoryId || normalizeSupplierMappingValue(plan.supplierSubcategory),
  supplierTaxonomyCategoryId: plan.supplierCategoryId || normalizeSupplierMappingValue(plan.supplierCategory),
  firstObservedAt: observedAt,
  lastObservedAt: observedAt,
});

const candidateCategory = (plan: SupplierTaxonomyCandidatePlan, observedAt: string): Record<string, unknown> => ({
  name: plan.supplierCategory,
  icon: "Package",
  isActive: false,
  taxonomyCandidate: true,
  taxonomyStatus: "pending",
  supplierTaxonomySourceId: plan.sourceId,
  supplierTaxonomyId: plan.supplierCategoryId || normalizeSupplierMappingValue(plan.supplierCategory),
  normalizedSupplierCategory: plan.normalizedCategory,
  firstObservedAt: observedAt,
  lastObservedAt: observedAt,
  ...(plan.subcategoryCandidate ? { subcategories: [candidateChild(plan, observedAt)] } : { subcategories: [] }),
});

const categoryIsSupplierCandidate = (value: Record<string, unknown>): boolean => value.taxonomyCandidate === true;

/**
 * Persists only inactive supplier taxonomy candidates. Existing admin-owned
 * categories and any category activated by an administrator are never changed
 * by this observation path.
 */
export async function upsertSupplierTaxonomyCandidate(
  db: Firestore,
  plan: SupplierTaxonomyCandidatePlan,
  observedAt: string,
): Promise<void> {
  const categoryReference = db.collection("categories").doc(plan.categoryId);
  await db.runTransaction(async (transaction) => {
    const categorySnapshot = await transaction.get(categoryReference);
    if (plan.categoryCandidate) {
      if (!categorySnapshot.exists) {
        transaction.create(categoryReference, candidateCategory(plan, observedAt));
        return;
      }
      const current = categorySnapshot.data() || {};
      if (!categoryIsSupplierCandidate(current) || current.isActive === true) return;
      const currentSubcategories = Array.isArray(current.subcategories)
        ? current.subcategories.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
        : [];
      const hasSubcategory = !plan.subcategoryCandidate || currentSubcategories.some((subcategory) => (
        String(subcategory.id || "") === plan.subcategoryId
        || (subcategory.supplierTaxonomySourceId === plan.sourceId
          && String(subcategory.supplierTaxonomyId || "") === (plan.supplierSubcategoryId || normalizeSupplierMappingValue(plan.supplierSubcategory)))
      ));
      transaction.set(categoryReference, {
        lastObservedAt: observedAt,
        ...(hasSubcategory ? {} : { subcategories: [...currentSubcategories, candidateChild(plan, observedAt)] }),
      }, { merge: true });
      return;
    }

    if (!categorySnapshot.exists) return;
    const current = categorySnapshot.data() || {};
    if (current.isActive === false) return;
    const currentSubcategories = Array.isArray(current.subcategories)
      ? current.subcategories.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
      : [];
    const existing = currentSubcategories.find((subcategory) => (
      String(subcategory.id || "") === plan.subcategoryId
      || (subcategory.supplierTaxonomySourceId === plan.sourceId
        && String(subcategory.supplierTaxonomyId || "") === (plan.supplierSubcategoryId || normalizeSupplierMappingValue(plan.supplierSubcategory)))
      || (subcategory.isActive !== false && normalizeSupplierMappingValue(subcategory.name) === normalizeSupplierMappingValue(plan.supplierSubcategory))
    ));
    if (existing) return;
    transaction.update(categoryReference, {
      subcategories: [...currentSubcategories, candidateChild(plan, observedAt)],
      updatedAt: observedAt,
    });
  });
}

export interface SupplierTaxonomyCandidateReviewer {
  uid: string;
  email: string;
}

export async function activateSupplierTaxonomyCandidate(
  db: Firestore,
  categoryIdInput: unknown,
  reviewer: SupplierTaxonomyCandidateReviewer,
  subcategoryIdInput?: unknown,
): Promise<{ categoryId: string; subcategoryId?: string; idempotent?: boolean }> {
  const categoryId = asString(categoryIdInput);
  const subcategoryId = asString(subcategoryIdInput);
  if (!categoryId || categoryId.includes("/") || categoryId.length > 160) {
    throw new ApiError("The taxonomy candidate ID is invalid.", 400);
  }
  const categoryReference = db.collection("categories").doc(categoryId);
  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    if (subcategoryId) {
      const snapshot = await transaction.get(categoryReference);
      if (!snapshot.exists || (snapshot.data()?.taxonomyCandidate !== true && snapshot.data()?.isActive !== true)) {
        throw new ApiError("The taxonomy candidate was not found.", 404);
      }
      const current = snapshot.data() || {};
      const subcategories = Array.isArray(current.subcategories)
        ? current.subcategories.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
        : [];
      const index = subcategories.findIndex((subcategory) => String(subcategory.id || "") === subcategoryId);
      if (index < 0 || subcategories[index].taxonomyCandidate !== true) {
        throw new ApiError("The taxonomy subcategory candidate was not found.", 404);
      }
      if (subcategories[index].isActive === true) return { categoryId, subcategoryId, idempotent: true };
      if (current.taxonomyCandidate === true && current.isActive !== true) {
        const normalizedName = normalizeSupplierMappingValue(current.name);
        const activeCategories = await transaction.get(db.collection("categories").where("isActive", "==", true));
        const duplicate = activeCategories.docs.some((document) => document.id !== categoryId
          && normalizeSupplierMappingValue(document.data().name) === normalizedName);
        if (duplicate) throw new ApiError("An active category with this name already exists; map the product to it instead.", 409);
      }
      const nextSubcategories = [...subcategories];
      nextSubcategories[index] = {
        ...nextSubcategories[index],
        isActive: true,
        taxonomyStatus: "active",
        activatedAt: now,
        activatedBy: reviewer.uid,
      };
      transaction.update(categoryReference, {
        subcategories: nextSubcategories,
        ...(current.taxonomyCandidate === true ? {
          isActive: true,
          taxonomyStatus: "active",
          activatedAt: now,
          activatedBy: reviewer.uid,
        } : {}),
        updatedAt: now,
      });
      return { categoryId, subcategoryId };
    }

    const activeQuery = db.collection("categories").where("isActive", "==", true);
    const [snapshot, activeCategories] = await Promise.all([
      transaction.get(categoryReference),
      transaction.get(activeQuery),
    ]);
    if (!snapshot.exists || snapshot.data()?.taxonomyCandidate !== true) {
      throw new ApiError("The taxonomy candidate was not found.", 404);
    }
    const current = snapshot.data() || {};
    if (current.isActive === true) return { categoryId, idempotent: true };
    const normalizedName = normalizeSupplierMappingValue(current.name);
    const duplicate = activeCategories.docs.some((document) => document.id !== categoryId
      && normalizeSupplierMappingValue(document.data().name) === normalizedName);
    if (duplicate) throw new ApiError("An active category with this name already exists; map the product to it instead.", 409);
    transaction.update(categoryReference, {
      isActive: true,
      taxonomyStatus: "active",
      activatedAt: now,
      activatedBy: reviewer.uid,
      updatedAt: now,
    });
    return { categoryId };
  });
}

export const projectSupplierTaxonomyCandidate = (value: unknown): Record<string, unknown> => {
  const candidate = asRecord(value);
  return {
    id: asString(candidate.id),
    name: asString(candidate.name),
    isActive: candidate.isActive === true,
    taxonomyCandidate: candidate.taxonomyCandidate === true,
    taxonomyStatus: asString(candidate.taxonomyStatus),
  };
};
