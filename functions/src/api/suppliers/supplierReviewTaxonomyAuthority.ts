const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const taxonomyOwner = (entry: unknown): string => typeof entry === "string" ? stringValue(entry) : stringValue(record(entry).owner);

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
