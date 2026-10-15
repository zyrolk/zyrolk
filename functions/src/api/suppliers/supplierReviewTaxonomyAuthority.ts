import {
  isCanonicalActiveCategory,
  normalizeSupplierMappingValue,
  type StoreCategoryMappingCandidate,
} from "./supplierProductMapping";

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const taxonomyOwner = (entry: unknown): string => typeof entry === "string" ? stringValue(entry) : stringValue(record(entry).owner);

const freshnessToken = (value: unknown): string => {
  if (value && typeof value === "object") {
    const timestamp = value as { toMillis?: unknown; seconds?: unknown; nanoseconds?: unknown };
    if (typeof timestamp.toMillis === "function") return String(timestamp.toMillis());
    if (typeof timestamp.seconds === "number") {
      return `${timestamp.seconds}:${typeof timestamp.nanoseconds === "number" ? timestamp.nanoseconds : 0}`;
    }
  }
  return stringValue(value);
};

const normalizedPhraseInEvidence = (evidence: string, phrase: unknown): boolean => {
  const normalizedEvidence = normalizeSupplierMappingValue(evidence);
  const normalizedPhrase = normalizeSupplierMappingValue(phrase);
  if (!normalizedEvidence || !normalizedPhrase) return false;
  return ` ${normalizedEvidence} `.includes(` ${normalizedPhrase} `);
};

const hasNegatedEvidence = (evidence: string, signals: readonly string[]): boolean => {
  const tokens = normalizeSupplierMappingValue(evidence).split(" ").filter(Boolean);
  const normalizedSignals = signals
    .map((signal) => normalizeSupplierMappingValue(signal).split(" ").filter(Boolean))
    .filter((signal) => signal.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const start = token === "instead" && tokens[index + 1] === "of"
      ? index + 2
      : ["not", "no", "without"].includes(token)
        ? index + 1
        : -1;
    if (start < 0) continue;
    const candidate = tokens.slice(start, start + 7);
    const withoutArticle = ["a", "an"].includes(candidate[0]) ? candidate.slice(1) : candidate;
    if (normalizedSignals.some((signal) => Array.from({ length: Math.min(4, withoutArticle.length) }, (_, offset) => offset)
      .some((offset) => signal.every((word, signalOffset) => withoutArticle[offset + signalOffset] === word)))) return true;
  }
  return false;
};

const productEvidence = (queueItem: Record<string, unknown>): {
  primary: string;
  supporting: string;
} => {
  const payload = record(queueItem.productPayload);
  const snapshot = record(queueItem.supplierSnapshot);
  const specs = record(payload.specs);
  const snapshotSpecs = record(snapshot.specifications);
  const primary = [payload.name, payload.productType].map(stringValue).filter(Boolean).join(" ");
  const supporting = [
    payload.description,
    payload.shortDescription,
    payload.keywords,
    snapshot.description,
    snapshot.productType,
    Object.keys(specs),
    Object.values(specs),
    Object.keys(snapshotSpecs),
    Object.values(snapshotSpecs),
  ].flatMap((value) => Array.isArray(value) ? value : [value])
    .map(stringValue)
    .filter(Boolean)
    .join(" ");
  return { primary, supporting };
};

/**
 * A source-derived taxonomy value is safe to retain only when the queue has
 * an exact source-scoped manual mapping and current canonical evidence can be
 * checked. This is an approval-time predicate; client values never establish
 * this authority.
 */
export const isTrustedSupplierDerivedReviewTaxonomy = (
  queueItem: Record<string, unknown>,
  category: StoreCategoryMappingCandidate | null | undefined,
  currentMapping: unknown,
  authority: {
    supplierCategory: boolean;
    supplierSubcategory: boolean;
  } = { supplierCategory: true, supplierSubcategory: true },
): boolean => {
  const comparisonStatus = String(queueItem.comparisonStatus || record(queueItem.comparison).comparisonStatus || "").toUpperCase();
  if (comparisonStatus !== "NEW_PRODUCT") return false;
  const payload = record(queueItem.productPayload);
  const mapping = record(queueItem.categoryMapping);
  const currentMappingRecord = record(currentMapping);
  if (!currentMappingRecord || Object.keys(currentMappingRecord).length === 0) return false;
  const sourceId = stringValue(queueItem.sourceId || record(queueItem.supplierSnapshot).sourceId);
  const queueVersion = Number(mapping.version);
  const currentVersion = Number(currentMappingRecord.version);
  const queueUpdatedAt = freshnessToken(mapping.updatedAt);
  const currentUpdatedAt = freshnessToken(currentMappingRecord.updatedAt);
  const queueMappingDocumentId = stringValue(mapping.mappingDocumentId);
  const currentMappingDocumentId = stringValue(currentMappingRecord.mappingDocumentId);
  if (!sourceId || !Number.isInteger(queueVersion) || queueVersion <= 0
    || queueVersion !== currentVersion || !queueUpdatedAt || queueUpdatedAt !== currentUpdatedAt
    || !queueMappingDocumentId || queueMappingDocumentId !== currentMappingDocumentId) return false;
  if (stringValue(mapping.sourceId) !== sourceId
    || stringValue(currentMappingRecord.sourceId) !== sourceId
    || currentMappingRecord.mappingType !== "manual"
    || Number(currentMappingRecord.confidence) < 100) return false;
  const categoryId = stringValue(payload.category);
  const mappedCategoryId = stringValue(mapping.targetCategoryId);
  if (!categoryId || mappedCategoryId !== categoryId) return false;
  if (mapping.mappingSource !== "source" || mapping.mappingType !== "manual" || mapping.autoSelected !== true
    || mapping.requiresManualSelection === true || Number(mapping.confidence) < 100
    || mapping.mappingScope !== currentMappingRecord.mappingScope) return false;
  // A parent-scoped mapping is authoritative only for the supplier category.
  // The source product may still carry a raw subcategory label, but that label
  // is not part of the parent mapping identity and must not be compared as if
  // the queue had a child-scoped mapping. Child mappings retain the exact
  // supplier subcategory identity check below.
  const compareSupplierSubcategoryIdentity = mapping.mappingScope === "child";
  const queueSubcategoryId = stringValue(mapping.supplierSubcategoryId);
  const currentSubcategoryId = stringValue(currentMappingRecord.supplierSubcategoryId);
  const queueSubcategoryName = normalizeSupplierMappingValue(mapping.normalizedSupplierSubcategory || mapping.supplierSubcategory);
  const currentSubcategoryName = normalizeSupplierMappingValue(
    currentMappingRecord.normalizedSupplierSubcategory || currentMappingRecord.supplierSubcategory,
  );
  if (stringValue(mapping.normalizedCategory) !== stringValue(currentMappingRecord.normalizedCategory)
    || stringValue(mapping.supplierCategory) !== stringValue(currentMappingRecord.supplierCategory)
    || stringValue(mapping.targetCategoryId) !== stringValue(currentMappingRecord.targetCategoryId)
    || stringValue(mapping.targetSubcategoryId) !== stringValue(currentMappingRecord.targetSubcategoryId)
    || compareSupplierSubcategoryIdentity && Boolean(queueSubcategoryId || currentSubcategoryId) && queueSubcategoryId !== currentSubcategoryId
    || compareSupplierSubcategoryIdentity && Boolean(queueSubcategoryName || currentSubcategoryName) && queueSubcategoryName !== currentSubcategoryName) return false;
  if (!category || category.id !== categoryId || !isCanonicalActiveCategory(category)) return false;

  const activeSubcategories = (category.subcategories || []).filter((subcategory) => (
    subcategory.isActive !== false && subcategory.taxonomyCandidate !== true
  ));
  const subcategoryId = stringValue(payload.subcategory);
  const mappedSubcategoryId = stringValue(mapping.targetSubcategoryId);
  if (activeSubcategories.length > 0) {
    if (!subcategoryId || !activeSubcategories.some((subcategory) => subcategory.id === subcategoryId)) return false;
    if (authority.supplierSubcategory && mappedSubcategoryId !== subcategoryId) return false;
    if (!authority.supplierSubcategory && mappedSubcategoryId && mappedSubcategoryId !== subcategoryId) return false;
  } else if (subcategoryId || mappedSubcategoryId) {
    return false;
  }

  const signals = [
    ...(authority.supplierCategory ? [category.name, ...(category.keywords || [])] : []),
    ...(authority.supplierSubcategory && subcategoryId
      ? activeSubcategories.filter((subcategory) => subcategory.id === subcategoryId).map((subcategory) => subcategory.name)
      : []),
  ].map(stringValue).filter(Boolean);
  const evidence = productEvidence(queueItem);
  const allEvidence = `${evidence.primary} ${evidence.supporting}`;
  if (signals.length === 0 || hasNegatedEvidence(allEvidence, signals)) return false;
  const primaryMatch = signals.some((signal) => normalizedPhraseInEvidence(evidence.primary, signal));
  const supportingMatch = signals.some((signal) => normalizedPhraseInEvidence(evidence.supporting, signal));
  if (!primaryMatch && !supportingMatch) return false;

  if (authority.supplierSubcategory && activeSubcategories.length > 1) {
    const evidencedSubcategories = activeSubcategories.filter((candidate) => (
      normalizedPhraseInEvidence(allEvidence, candidate.name)
    ));
    if (evidencedSubcategories.some((candidate) => candidate.id !== subcategoryId)
      || evidencedSubcategories.length > 1) return false;
  }
  return true;
};

/**
 * Legacy NEW_PRODUCT review records may still carry a category that an old
 * supplier mapping auto-selected. That stored value is not Zyro taxonomy
 * authority and must remain untrusted until an administrator selects it.
 */
export const hasLegacySupplierDerivedReviewTaxonomy = (queueItem: Record<string, unknown>): boolean => {
  const comparisonStatus = String(queueItem.comparisonStatus || record(queueItem.comparison).comparisonStatus || "").toUpperCase();
  if (comparisonStatus !== "NEW_PRODUCT") return false;
  const payload = record(queueItem.productPayload);
  const storedCategory = stringValue(payload.category);
  if (!storedCategory) return false;
  const mapping = record(queueItem.categoryMapping);
  if (mapping.autoSelected !== true || stringValue(mapping.targetCategoryId) !== storedCategory) return false;
  const ownership = record(payload.supplierFieldOwnership);
  return !["category", "subcategory"].some((field) => taxonomyOwner(ownership[field]) === "admin");
};

export const projectLegacySupplierDerivedReviewValidation = (
  queueItem: Record<string, unknown>,
  categoryRequiresSubcategory = false,
): Record<string, unknown> => {
  if (!hasLegacySupplierDerivedReviewTaxonomy(queueItem)) return queueItem;

  const validation = record(queueItem.productValidation);
  const missingFields = Array.isArray(validation.missingFields)
    ? validation.missingFields.map((field) => String(field))
    : [];
  const errors = Array.isArray(validation.errors) ? [...validation.errors] : [];
  const addMissing = (field: string, code: string, message: string): void => {
    if (!missingFields.includes(field)) missingFields.push(field);
    if (!errors.some((entry) => {
      const error = record(entry);
      return stringValue(error.field) === field && stringValue(error.code) === code;
    })) {
      errors.push({ field, code, message });
    }
  };

  addMissing("category", "required", "Category is required.");
  if (categoryRequiresSubcategory) {
    addMissing("subcategory", "required", "Subcategory is required for this category.");
  }

  return {
    ...queueItem,
    productValidation: {
      ...validation,
      readyToPublish: false,
      missingFields,
      errors,
    },
  };
};
