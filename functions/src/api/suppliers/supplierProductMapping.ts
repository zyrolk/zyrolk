import { createHash } from "node:crypto";

export type SupplierMappingType = "manual" | "learned" | "exact" | "normalized" | "keyword" | "unmapped";

export interface SupplierCategoryMappingRecord {
  sourceId: string;
  supplierCategory: string;
  normalizedCategory: string;
  targetCategoryId: string;
  targetSubcategoryId: string;
  confidence: number;
  mappingType: SupplierMappingType;
  version: number;
  updatedBy: string;
  updatedAt?: unknown;
}

export interface SupplierBrandMappingRecord {
  sourceId: string;
  supplierBrand: string;
  normalizedBrand: string;
  mappedBrandId: string;
  confidence: number;
  mappingType: SupplierMappingType;
  version: number;
  updatedBy: string;
  updatedAt?: unknown;
}

export interface StoreCategoryMappingCandidate {
  id: string;
  name: string;
  isActive?: boolean;
  subcategories?: Array<{ id: string; name: string; isActive?: boolean }>;
  specificationTemplate?: Array<{ name: string; required?: boolean }>;
  keywords?: string[];
}

export interface StoreBrandMappingCandidate {
  id: string;
  name: string;
  isActive?: boolean;
  aliases?: string[];
}

export interface SupplierCategorySuggestion {
  supplierCategory: string;
  normalizedCategory: string;
  targetCategoryId: string;
  targetSubcategoryId: string;
  confidence: number;
  mappingType: SupplierMappingType;
  mappingSource: "source" | "global" | "catalog" | "none";
  autoSelected: boolean;
  requiresManualSelection: boolean;
}

export interface SupplierBrandSuggestion {
  supplierBrand: string;
  normalizedBrand: string;
  mappedBrandId: string;
  confidence: number;
  mappingType: SupplierMappingType;
  mappingSource: "source" | "global" | "registry" | "none";
  autoSelected: boolean;
  requiresManualSelection: boolean;
}

export interface SupplierProductValidationError {
  field: string;
  code: string;
  message: string;
}

export const normalizeSupplierMappingValue = (value: unknown): string => String(value || "")
  .normalize("NFKC")
  .trim()
  .toLocaleLowerCase("en")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const activeCategories = (categories: readonly StoreCategoryMappingCandidate[]) => categories.filter((category) => category.isActive !== false);
const activeBrands = (brands: readonly StoreBrandMappingCandidate[]) => brands.filter((brand) => brand.isActive !== false);

const mappingScope = (mappingSourceId: string, sourceId: string): "source" | "global" | null => {
  if (mappingSourceId === sourceId) return "source";
  return ["*", "global"].includes(mappingSourceId) ? "global" : null;
};

const validMappedSubcategory = (
  category: StoreCategoryMappingCandidate,
  subcategoryId: string,
): string => {
  if (!subcategoryId) return "";
  return category.subcategories?.find((item) => item.id === subcategoryId && item.isActive !== false)?.id || "";
};

const words = (value: unknown): string[] => normalizeSupplierMappingValue(value).split(" ").filter((word) => word.length > 1);

const overlapScore = (evidence: string, candidate: string): number => {
  const candidateWords = [...new Set(words(candidate))];
  if (candidateWords.length === 0) return 0;
  const evidenceWords = new Set(words(evidence));
  return candidateWords.filter((word) => evidenceWords.has(word)).length / candidateWords.length;
};

const bestSubcategory = (category: StoreCategoryMappingCandidate, evidence: string): { id: string; score: number } => {
  let result = { id: "", score: 0 };
  for (const subcategory of category.subcategories || []) {
    if (subcategory.isActive === false) continue;
    const normalizedName = normalizeSupplierMappingValue(subcategory.name);
    const normalizedId = normalizeSupplierMappingValue(subcategory.id);
    const exact = [normalizedName, normalizedId].some((value) => value && evidence.includes(value));
    const score = exact ? 1 : Math.max(overlapScore(evidence, normalizedName), overlapScore(evidence, normalizedId));
    if (score > result.score) result = { id: subcategory.id, score };
  }
  return result.score >= 0.7 ? result : { id: "", score: result.score };
};

export function suggestSupplierCategory(input: {
  sourceId: string;
  supplierCategories: readonly string[];
  productTitle?: string;
  keywords?: readonly string[];
  productType?: string;
  categories: readonly StoreCategoryMappingCandidate[];
  mappings?: readonly SupplierCategoryMappingRecord[];
}): SupplierCategorySuggestion {
  const supplierCategory = input.supplierCategories.map((item) => String(item || "").trim()).find(Boolean) || "";
  const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
  const categories = activeCategories(input.categories);
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const evidence = normalizeSupplierMappingValue([
    ...input.supplierCategories,
    input.productTitle || "",
    ...(input.keywords || []),
    input.productType || "",
  ].join(" "));
  const manualMappings = (input.mappings || [])
    .map((mapping) => ({ mapping, scope: mappingScope(mapping.sourceId, input.sourceId) }))
    .filter((entry): entry is { mapping: SupplierCategoryMappingRecord; scope: "source" | "global" } => Boolean(entry.scope))
    .filter(({ mapping }) => normalizeSupplierMappingValue(mapping.normalizedCategory || mapping.supplierCategory) === normalizedCategory)
    .sort((left, right) => Number(right.scope === "source") - Number(left.scope === "source") || right.mapping.version - left.mapping.version);

  for (const { mapping, scope } of manualMappings) {
    const category = categoryById.get(mapping.targetCategoryId);
    if (!category) continue;
    return {
      supplierCategory,
      normalizedCategory,
      targetCategoryId: category.id,
      targetSubcategoryId: validMappedSubcategory(category, mapping.targetSubcategoryId),
      confidence: 100,
      mappingType: mapping.mappingType === "learned" ? "learned" : "manual",
      mappingSource: scope,
      autoSelected: true,
      requiresManualSelection: false,
    };
  }

  for (const category of categories) {
    if (supplierCategory && (supplierCategory === category.id || supplierCategory === category.name)) {
      const subcategory = bestSubcategory(category, evidence);
      return {
        supplierCategory, normalizedCategory, targetCategoryId: category.id, targetSubcategoryId: subcategory.id,
        confidence: 100, mappingType: "exact", mappingSource: "catalog", autoSelected: true, requiresManualSelection: false,
      };
    }
  }

  for (const category of categories) {
    if ([category.id, category.name].some((value) => normalizeSupplierMappingValue(value) === normalizedCategory && normalizedCategory)) {
      const subcategory = bestSubcategory(category, evidence);
      return {
        supplierCategory, normalizedCategory, targetCategoryId: category.id, targetSubcategoryId: subcategory.id,
        confidence: 98, mappingType: "normalized", mappingSource: "catalog", autoSelected: true, requiresManualSelection: false,
      };
    }
  }

  let best: { category: StoreCategoryMappingCandidate; score: number; subcategoryId: string } | null = null;
  for (const category of categories) {
    const categorySignals = [category.id, category.name, ...(category.keywords || [])];
    const categoryScore = Math.max(...categorySignals.map((signal) => overlapScore(evidence, signal)), 0);
    const subcategory = bestSubcategory(category, evidence);
    const score = Math.max(categoryScore, subcategory.score * 0.95);
    if (!best || score > best.score) best = { category, score, subcategoryId: subcategory.id };
  }
  if (best && best.score >= 0.4) {
    const suggestionConfidence = Math.min(94, Math.max(70, Math.round(70 + best.score * 24)));
    return {
      supplierCategory,
      normalizedCategory,
      targetCategoryId: best.category.id,
      targetSubcategoryId: best.subcategoryId,
      confidence: suggestionConfidence,
      mappingType: "keyword",
      mappingSource: "catalog",
      autoSelected: suggestionConfidence >= 95,
      requiresManualSelection: suggestionConfidence < 80,
    };
  }

  return {
    supplierCategory, normalizedCategory, targetCategoryId: "", targetSubcategoryId: "", confidence: 0,
    mappingType: "unmapped", mappingSource: "none", autoSelected: false, requiresManualSelection: true,
  };
}

const GENERIC_BRAND_SUFFIXES = new Set(["mobile", "mobiles", "electronics", "official", "store", "shop"]);
const withoutGenericBrandSuffix = (value: string): string => normalizeSupplierMappingValue(value)
  .split(" ")
  .filter((word) => !GENERIC_BRAND_SUFFIXES.has(word))
  .join(" ");

export function suggestSupplierBrand(input: {
  sourceId: string;
  supplierBrand: string;
  brands: readonly StoreBrandMappingCandidate[];
  mappings?: readonly SupplierBrandMappingRecord[];
}): SupplierBrandSuggestion {
  const supplierBrand = String(input.supplierBrand || "").trim();
  const normalizedBrand = normalizeSupplierMappingValue(supplierBrand);
  const brands = activeBrands(input.brands);
  const brandById = new Map(brands.map((brand) => [brand.id, brand]));
  const manualMappings = (input.mappings || [])
    .map((mapping) => ({ mapping, scope: mappingScope(mapping.sourceId, input.sourceId) }))
    .filter((entry): entry is { mapping: SupplierBrandMappingRecord; scope: "source" | "global" } => Boolean(entry.scope))
    .filter(({ mapping }) => normalizeSupplierMappingValue(mapping.normalizedBrand || mapping.supplierBrand) === normalizedBrand)
    .sort((left, right) => Number(right.scope === "source") - Number(left.scope === "source") || right.mapping.version - left.mapping.version);
  for (const { mapping, scope } of manualMappings) {
    if (!brandById.has(mapping.mappedBrandId)) continue;
    return {
      supplierBrand, normalizedBrand, mappedBrandId: mapping.mappedBrandId, confidence: 100,
      mappingType: mapping.mappingType === "learned" ? "learned" : "manual", mappingSource: scope,
      autoSelected: true, requiresManualSelection: false,
    };
  }
  for (const brand of brands) {
    if (supplierBrand && (supplierBrand === brand.id || supplierBrand === brand.name)) {
      return { supplierBrand, normalizedBrand, mappedBrandId: brand.id, confidence: 100, mappingType: "exact", mappingSource: "registry", autoSelected: true, requiresManualSelection: false };
    }
  }
  for (const brand of brands) {
    if ([brand.id, brand.name, ...(brand.aliases || [])].some((value) => normalizeSupplierMappingValue(value) === normalizedBrand && normalizedBrand)) {
      return { supplierBrand, normalizedBrand, mappedBrandId: brand.id, confidence: 98, mappingType: "normalized", mappingSource: "registry", autoSelected: true, requiresManualSelection: false };
    }
  }
  const simplified = withoutGenericBrandSuffix(normalizedBrand);
  if (simplified) {
    const match = brands.find((brand) => [brand.id, brand.name, ...(brand.aliases || [])]
      .some((value) => withoutGenericBrandSuffix(normalizeSupplierMappingValue(value)) === simplified));
    if (match) {
      return { supplierBrand, normalizedBrand, mappedBrandId: match.id, confidence: 96, mappingType: "keyword", mappingSource: "registry", autoSelected: true, requiresManualSelection: false };
    }
  }
  return { supplierBrand, normalizedBrand, mappedBrandId: "", confidence: 0, mappingType: "unmapped", mappingSource: "none", autoSelected: false, requiresManualSelection: true };
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

export function validateSupplierProductForApproval(
  product: Record<string, unknown>,
  categories: readonly StoreCategoryMappingCandidate[],
  brands: readonly StoreBrandMappingCandidate[],
): SupplierProductValidationError[] {
  const errors: SupplierProductValidationError[] = [];
  const add = (field: string, code: string, message: string) => errors.push({ field, code, message });
  if (!String(product.name || "").trim()) add("name", "required", "Product name is required.");
  const imageUrl = String(product.imageUrl || "").trim();
  if (!/^https?:\/\/\S+$/iu.test(imageUrl)) add("imageUrl", "invalid", "A valid product image is required.");
  const price = Number(product.price);
  if (!Number.isFinite(price) || price <= 0) add("price", "invalid", "Selling price must be greater than zero.");
  const stock = Number(product.stock);
  if (!Number.isInteger(stock) || stock < 0) add("stock", "invalid", "Stock must be a non-negative whole number.");
  if (![product.isActive, product.active, product.visible].some((value) => typeof value === "boolean")) {
    add("visibility", "required", "Product visibility must be selected.");
  }

  const categoryId = String(product.category || "").trim();
  const category = categories.find((candidate) => candidate.id === categoryId);
  if (!category || category.isActive === false) {
    add("category", "invalid", "Select an active product category.");
  } else {
    const activeSubcategories = (category.subcategories || []).filter((subcategory) => subcategory.isActive !== false);
    const subcategoryId = String(product.subcategory || "").trim();
    if (activeSubcategories.length > 0 && !activeSubcategories.some((subcategory) => subcategory.id === subcategoryId)) {
      add("subcategory", "invalid", "Select an active subcategory belonging to the category.");
    }
    const specs = asRecord(product.specs);
    const normalizedSpecs = new Map(Object.entries(specs).map(([key, value]) => [normalizeSupplierMappingValue(key), String(value || "").trim()]));
    for (const field of category.specificationTemplate || []) {
      if (field.required && !normalizedSpecs.get(normalizeSupplierMappingValue(field.name))) {
        add(`specs.${field.name}`, "required", `Required specification "${field.name}" must have a value.`);
      }
    }
  }

  const brandId = String(product.brand || "").trim();
  const brand = brands.find((candidate) => candidate.id === brandId);
  if (!brand || brand.isActive === false) add("brand", "invalid", "Select an active registered brand.");
  return errors;
}

export const supplierMappingDocumentId = (sourceId: string, normalizedValue: string): string => {
  const digest = createHash("sha256").update(`${sourceId}\u0000${normalizedValue}`).digest("hex").slice(0, 24);
  return `${sourceId.replace(/[^a-z0-9_-]+/giu, "-").slice(0, 60) || "source"}-${digest}`;
};
