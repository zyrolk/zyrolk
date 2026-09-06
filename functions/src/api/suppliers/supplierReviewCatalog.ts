import type { Firestore } from "firebase-admin/firestore";

export interface SupplierReviewCatalogSubcategory {
  id: string;
  name: string;
  isActive?: boolean;
}

export interface SupplierReviewCatalogCategory {
  id: string;
  name: string;
  isActive: boolean;
  subcategories: SupplierReviewCatalogSubcategory[];
  specificationTemplate: Array<{ name: string; required?: boolean }>;
}

export interface SupplierReviewCatalogBrand {
  id: string;
  name: string;
  isActive: boolean;
}

export interface SupplierReviewCatalogTaxonomy {
  categories: SupplierReviewCatalogCategory[];
  brands: SupplierReviewCatalogBrand[];
}

const normalizeCatalogText = (value: unknown): string => String(value || "")
  .normalize("NFKC")
  .trim()
  .replace(/\s+/gu, " ");

const projectSubcategories = (value: unknown): SupplierReviewCatalogSubcategory[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SupplierReviewCatalogSubcategory[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeCatalogText(record.id || record.name).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
    const name = normalizeCatalogText(record.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name, isActive: record.isActive !== false });
  }
  return result;
};

const projectSpecificationTemplate = (value: unknown): Array<{ name: string; required?: boolean }> => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Array<{ name: string; required?: boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = normalizeCatalogText(record.name);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, required: record.required === true });
  }
  return result;
};

export const projectSupplierReviewCatalogRecords = (
  categoryDocs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
  brandDocs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
): SupplierReviewCatalogTaxonomy => ({
  categories: categoryDocs
    .map((document) => {
      const data = document.data;
      return {
        id: document.id,
        name: normalizeCatalogText(data.name) || document.id,
        isActive: data.isActive !== false,
        subcategories: projectSubcategories(data.subcategories),
        specificationTemplate: projectSpecificationTemplate(data.specificationTemplate),
      } satisfies SupplierReviewCatalogCategory;
    })
    .filter((category) => category.isActive)
    .sort((left, right) => left.name.localeCompare(right.name)),
  brands: brandDocs
    .map((document) => {
      const data = document.data;
      return {
        id: document.id,
        name: normalizeCatalogText(data.name) || document.id,
        isActive: data.isActive !== false,
      } satisfies SupplierReviewCatalogBrand;
    })
    .filter((brand) => brand.isActive)
    .sort((left, right) => left.name.localeCompare(right.name)),
});

export async function loadSupplierReviewCatalogTaxonomy(db: Firestore): Promise<SupplierReviewCatalogTaxonomy> {
  const [categorySnapshot, brandSnapshot] = await Promise.all([
    db.collection("categories").get(),
    db.collection("brands").get(),
  ]);
  return projectSupplierReviewCatalogRecords(
    categorySnapshot.docs.map((document) => ({ id: document.id, data: document.data() })),
    brandSnapshot.docs.map((document) => ({ id: document.id, data: document.data() })),
  );
}
