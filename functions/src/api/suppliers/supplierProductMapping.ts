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
  subcategories?: Array<{
    id: string;
    name: string;
    isActive?: boolean;
    taxonomyCandidate?: boolean;
    supplierTaxonomySourceId?: string;
    supplierTaxonomyId?: string;
  }>;
  specificationTemplate?: Array<{ name: string; required?: boolean }>;
  keywords?: string[];
  taxonomyCandidate?: boolean;
  supplierTaxonomySourceId?: string;
  supplierTaxonomyId?: string;
  normalizedSupplierCategory?: string;
}

export interface StoreBrandMappingCandidate {
  id: string;
  name: string;
  isActive?: boolean;
  aliases?: string[];
}

export interface SupplierCategorySuggestion {
  supplierCategory: string;
  supplierSubcategory?: string;
  normalizedCategory: string;
  targetCategoryId: string;
  targetSubcategoryId: string;
  candidateCategoryId?: string;
  candidateSubcategoryId?: string;
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

export interface SupplierTaxonomyCandidatePlan {
  categoryId: string;
  subcategoryId: string;
  categoryCandidate: boolean;
  subcategoryCandidate: boolean;
  sourceId: string;
  supplierCategoryId: string;
  supplierCategory: string;
  normalizedCategory: string;
  supplierSubcategory: string;
  supplierSubcategoryId: string;
  parentCategoryId?: string;
}

export const buildSupplierTaxonomyCandidateId = (
  sourceId: string,
  supplierCategoryId: string,
  supplierCategory: string,
): string => `supplier-taxonomy-${createHash("sha256")
  .update([sourceId, supplierCategoryId || normalizeSupplierMappingValue(supplierCategory)].join("\u001f"), "utf8")
  .digest("hex")}`;

export const buildSupplierTaxonomyCandidateSubcategoryId = (
  sourceId: string,
  categoryId: string,
  supplierSubcategoryId: string,
  supplierSubcategory: string,
): string => `supplier-taxonomy-sub-${createHash("sha256")
  .update([sourceId, categoryId, supplierSubcategoryId || normalizeSupplierMappingValue(supplierSubcategory)].join("\u001f"), "utf8")
  .digest("hex")}`;

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

export function suggestSupplierCategory(input: {
  sourceId: string;
  supplierCategories: readonly string[];
  productTitle?: string;
  keywords?: readonly string[];
  productType?: string;
  categories: readonly StoreCategoryMappingCandidate[];
  mappings?: readonly SupplierCategoryMappingRecord[];
}): SupplierCategorySuggestion {
  const supplierValues = input.supplierCategories.map((item) => String(item || "").trim()).filter(Boolean);
  const supplierCategory = supplierValues[0] || "";
  const supplierSubcategory = supplierValues[1] || "";
  const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
  const categories = activeCategories(input.categories);
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const exactSubcategoryId = (category: StoreCategoryMappingCandidate): string => {
    if (!supplierSubcategory) return "";
    return category.subcategories?.find((subcategory) => subcategory.isActive !== false
      && [subcategory.id, subcategory.name].some((value) => normalizeSupplierMappingValue(value) === normalizeSupplierMappingValue(supplierSubcategory)))?.id || "";
  };
  const unresolvedSubcategory = (category: StoreCategoryMappingCandidate): boolean => Boolean(supplierSubcategory && !exactSubcategoryId(category));
  const evidence = normalizeSupplierMappingValue([
    ...supplierValues,
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
      supplierSubcategory,
      normalizedCategory,
      targetCategoryId: category.id,
      targetSubcategoryId: validMappedSubcategory(category, mapping.targetSubcategoryId) || exactSubcategoryId(category),
      confidence: 100,
      mappingType: mapping.mappingType === "learned" ? "learned" : "manual",
      mappingSource: scope,
      autoSelected: true,
      requiresManualSelection: false,
    };
  }

  const matchesInactiveCategory = Boolean(normalizedCategory) && input.categories.some((category) => (
    category.isActive === false
    && [category.id, category.name, category.normalizedSupplierCategory, category.supplierTaxonomyId]
      .some((value) => normalizeSupplierMappingValue(value) === normalizedCategory)
  ));
  if (matchesInactiveCategory) {
    const inactiveCandidate = input.categories.find((category) => category.isActive === false
      && category.taxonomyCandidate === true
      && [category.name, category.normalizedSupplierCategory, category.supplierTaxonomyId]
        .some((value) => normalizeSupplierMappingValue(value) === normalizedCategory));
    return {
      supplierCategory, supplierSubcategory, normalizedCategory, targetCategoryId: "", targetSubcategoryId: "",
      ...(inactiveCandidate ? { candidateCategoryId: inactiveCandidate.id } : {}),
      confidence: 0,
      mappingType: "unmapped", mappingSource: "none", autoSelected: false, requiresManualSelection: true,
    };
  }

  for (const category of categories) {
    if (supplierCategory && (supplierCategory === category.id || supplierCategory === category.name)) {
      return {
        supplierCategory, supplierSubcategory, normalizedCategory, targetCategoryId: category.id,
        targetSubcategoryId: exactSubcategoryId(category), confidence: 100, mappingType: "exact", mappingSource: "catalog",
        autoSelected: !unresolvedSubcategory(category), requiresManualSelection: unresolvedSubcategory(category),
      };
    }
  }

  for (const category of categories) {
    if ([category.id, category.name].some((value) => normalizeSupplierMappingValue(value) === normalizedCategory && normalizedCategory)) {
      return {
        supplierCategory, supplierSubcategory, normalizedCategory, targetCategoryId: category.id,
        targetSubcategoryId: exactSubcategoryId(category), confidence: 98, mappingType: "normalized", mappingSource: "catalog",
        autoSelected: !unresolvedSubcategory(category), requiresManualSelection: unresolvedSubcategory(category),
      };
    }
  }

  let best: { category: StoreCategoryMappingCandidate; score: number } | null = null;
  for (const category of categories) {
    const categorySignals = [category.id, category.name, ...(category.keywords || [])];
    const categoryScore = Math.max(...categorySignals.map((signal) => overlapScore(evidence, signal)), 0);
    if (!best || categoryScore > best.score) best = { category, score: categoryScore };
  }
  if (best && best.score >= 0.4) {
    const suggestionConfidence = Math.min(94, Math.max(70, Math.round(70 + best.score * 24)));
    return {
      supplierCategory,
      supplierSubcategory,
      normalizedCategory,
      targetCategoryId: best.category.id,
      targetSubcategoryId: "",
      confidence: suggestionConfidence,
      mappingType: "keyword",
      mappingSource: "catalog",
      autoSelected: suggestionConfidence >= 95,
      requiresManualSelection: suggestionConfidence < 80,
    };
  }

  return {
    supplierCategory, supplierSubcategory, normalizedCategory, targetCategoryId: "", targetSubcategoryId: "", confidence: 0,
    mappingType: "unmapped", mappingSource: "none", autoSelected: false, requiresManualSelection: true,
  };
}

const supplierCategoryMatches = (
  category: StoreCategoryMappingCandidate,
  normalizedCategory: string,
  supplierCategoryId: string,
): boolean => [category.id, category.name, category.normalizedSupplierCategory, category.supplierTaxonomyId]
  .some((value) => normalizeSupplierMappingValue(value) === normalizedCategory
    || (supplierCategoryId && String(value || "").trim() === supplierCategoryId));

const supplierSubcategoryMatches = (
  subcategory: { id: string; name: string; isActive?: boolean; taxonomyCandidate?: boolean; supplierTaxonomySourceId?: string; supplierTaxonomyId?: string },
  normalizedSubcategory: string,
  sourceId: string,
  supplierSubcategoryId: string,
): boolean => [subcategory.id, subcategory.name, subcategory.supplierTaxonomyId]
  .some((value) => normalizeSupplierMappingValue(value) === normalizedSubcategory
    || (supplierSubcategoryId && String(value || "").trim() === supplierSubcategoryId))
  && (!subcategory.taxonomyCandidate || subcategory.supplierTaxonomySourceId === sourceId);

export function planSupplierTaxonomyCandidates(input: {
  sourceId: string;
  supplierCategory: string;
  supplierCategoryId?: string;
  supplierSubcategory?: string;
  supplierSubcategoryId?: string;
  categories: readonly StoreCategoryMappingCandidate[];
  mapping?: SupplierCategorySuggestion;
}): SupplierTaxonomyCandidatePlan | null {
  const supplierCategory = String(input.supplierCategory || "").trim();
  const supplierSubcategory = String(input.supplierSubcategory || "").trim();
  const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
  const normalizedSubcategory = normalizeSupplierMappingValue(supplierSubcategory);
  const supplierCategoryId = String(input.supplierCategoryId || "").trim();
  const supplierSubcategoryId = String(input.supplierSubcategoryId || "").trim();
  if (!supplierCategory || !normalizedCategory) return null;

  const activeCategory = input.categories.find((category) => category.isActive !== false
    && supplierCategoryMatches(category, normalizedCategory, supplierCategoryId));
  const mappedCategory = input.mapping?.autoSelected && input.mapping.targetCategoryId
    ? input.categories.find((category) => category.isActive !== false && category.id === input.mapping?.targetCategoryId)
    : undefined;
  const safeParent = activeCategory || mappedCategory;
  if (safeParent) {
    if (!supplierSubcategory || input.mapping?.targetSubcategoryId) return null;
    const activeSubcategory = (safeParent.subcategories || []).find((subcategory) => subcategory.isActive !== false
      && [subcategory.id, subcategory.name].some((value) => normalizeSupplierMappingValue(value) === normalizedSubcategory
        || (supplierSubcategoryId && String(value || "").trim() === supplierSubcategoryId)));
    if (activeSubcategory) return null;
    const existingCandidate = (safeParent.subcategories || []).find((subcategory) => subcategory.isActive === false
      && supplierSubcategoryMatches(subcategory, normalizedSubcategory, input.sourceId, supplierSubcategoryId));
    return {
      categoryId: safeParent.id,
      subcategoryId: existingCandidate?.id || buildSupplierTaxonomyCandidateSubcategoryId(input.sourceId, safeParent.id, supplierSubcategoryId, supplierSubcategory),
      categoryCandidate: false,
      subcategoryCandidate: true,
      sourceId: input.sourceId,
      supplierCategoryId,
      supplierCategory,
      normalizedCategory,
      supplierSubcategory,
      supplierSubcategoryId,
      parentCategoryId: safeParent.id,
    };
  }

  const existingCandidate = input.categories.find((category) => category.isActive === false
    && category.taxonomyCandidate === true
    && category.supplierTaxonomySourceId === input.sourceId
    && supplierCategoryMatches(category, normalizedCategory, supplierCategoryId));
  const existingInactiveOwnedCategory = input.categories.find((category) => category.isActive === false
    && category.taxonomyCandidate !== true
    && supplierCategoryMatches(category, normalizedCategory, supplierCategoryId));
  if (existingInactiveOwnedCategory && !existingCandidate) return null;
  const categoryId = existingCandidate?.id || buildSupplierTaxonomyCandidateId(input.sourceId, supplierCategoryId, supplierCategory);
  const existingSubcategory = existingCandidate?.subcategories?.find((subcategory) => subcategory.isActive === false
    && supplierSubcategoryMatches(subcategory, normalizedSubcategory, input.sourceId, supplierSubcategoryId));
  return {
    categoryId,
    subcategoryId: supplierSubcategory
      ? existingSubcategory?.id || buildSupplierTaxonomyCandidateSubcategoryId(input.sourceId, categoryId, supplierSubcategoryId, supplierSubcategory)
      : "",
    categoryCandidate: true,
    subcategoryCandidate: Boolean(supplierSubcategory),
    sourceId: input.sourceId,
    supplierCategoryId,
    supplierCategory,
    normalizedCategory,
    supplierSubcategory,
    supplierSubcategoryId,
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

const optionRequiresSelection = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.filter((entry) => String(entry ?? "").trim()).length > 1;
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  if (option.required === true) return true;
  return [option.values, option.options, option.choices].some((choices) => Array.isArray(choices) && choices.length > 1);
};

export function requiresUnsupportedVariantSelection(product: Record<string, unknown>): boolean {
  if (product.variantSelectionRequired === true) return true;
  const variants = product.variants;
  if (Array.isArray(variants) && variants.length > 1) return true;
  if (variants && typeof variants === "object" && !Array.isArray(variants) && Object.keys(variants).length > 1) return true;
  const options = product.options;
  if (Array.isArray(options)) return options.some(optionRequiresSelection);
  return Object.values(asRecord(options)).some(optionRequiresSelection);
}

export function validateSupplierProductForApproval(
  product: Record<string, unknown>,
  categories: readonly StoreCategoryMappingCandidate[],
  brands: readonly StoreBrandMappingCandidate[],
  options: { supplierReview?: boolean } = {},
): SupplierProductValidationError[] {
  const errors: SupplierProductValidationError[] = [];
  const add = (field: string, code: string, message: string) => errors.push({ field, code, message });
  if (!String(product.name || "").trim()) add("name", "required", "Product name is required.");
  const imageUrl = String(product.imageUrl || "").trim();
  if (!/^https?:\/\/\S+$/iu.test(imageUrl)) add("imageUrl", "invalid", "A valid product image is required.");
  const price = Number(product.price);
  if (!Number.isFinite(price) || price <= 0) add("price", "invalid", "Selling price must be greater than zero.");
  const costPrice = Number(product.costPrice);
  if (Number.isFinite(price) && price > 0 && Number.isFinite(costPrice) && costPrice > price) {
    add("price", "below_supplier_cost", "Selling price must be at least the supplier cost.");
  }
  if (!String(product.description || "").trim()) add("description", "required", "Full description is required.");
  const metadata = asRecord(product.supplierMetadata);
  if (metadata.supplierCostAvailable === false) {
    const cost = Number(product.costPrice);
    if (!Number.isFinite(cost) || cost < 0) {
      add("costPrice", "missing_cost", "Supplier cost was not provided. Enter a valid supplier cost before approval.");
    }
  }
  const stock = Number(product.stock);
  if (metadata.supplierStockAvailable === false) {
    add("stock", "missing_stock", "Supplier inventory was not provided.");
  } else if (!Number.isInteger(stock) || stock < 0) {
    add("stock", "invalid", "Stock must be a non-negative whole number.");
  }
  if (![product.isActive, product.active, product.visible].some((value) => typeof value === "boolean")) {
    add("visibility", "required", "Product visibility must be selected.");
  }
  if (requiresUnsupportedVariantSelection(product)) {
    add(
      "variants",
      "unsupported_variant_selection",
      "This product requires a variant selection that the storefront cannot safely sell yet.",
    );
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
    if (options.supplierReview !== true) {
      const specs = asRecord(product.specs);
      const normalizedSpecs = new Map(Object.entries(specs).map(([key, value]) => [normalizeSupplierMappingValue(key), String(value || "").trim()]));
      for (const field of category.specificationTemplate || []) {
        if (field.required && !normalizedSpecs.get(normalizeSupplierMappingValue(field.name))) {
          add(`specs.${field.name}`, "required", `Required specification "${field.name}" must have a value.`);
        }
      }
    }
  }

  const brandId = String(product.brand || "").trim();
  if (brandId) {
    const brand = brands.find((candidate) => candidate.id === brandId);
    if (!brand || brand.isActive === false) add("brand", "invalid", "Select an active registered brand.");
  }
  return errors;
}

export const supplierMappingDocumentId = (sourceId: string, normalizedValue: string): string => {
  const digest = createHash("sha256").update(`${sourceId}\u0000${normalizedValue}`).digest("hex").slice(0, 24);
  return `${sourceId.replace(/[^a-z0-9_-]+/giu, "-").slice(0, 60) || "source"}-${digest}`;
};
