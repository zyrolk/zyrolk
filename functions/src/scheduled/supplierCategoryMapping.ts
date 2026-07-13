export interface StoreCategoryReference {
  id: string;
  name?: string;
}

export type SupplierCategoryMappings = Record<string, string>;

export const normalizeSupplierCategory = (value: unknown): string => String(value || '')
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase('en')
  .replace(/[\s_-]+/g, ' ');

export function resolveSupplierCategory(
  supplierCategories: readonly string[] | undefined,
  storeCategories: readonly StoreCategoryReference[],
  mappings: SupplierCategoryMappings | undefined,
): string {
  const availableIds = new Set(storeCategories.map((category) => category.id));
  const availableByName = new Map<string, string>();
  storeCategories.forEach((category) => {
    availableByName.set(normalizeSupplierCategory(category.id), category.id);
    availableByName.set(normalizeSupplierCategory(category.name), category.id);
  });

  for (const supplierCategory of supplierCategories || []) {
    const normalized = normalizeSupplierCategory(supplierCategory);
    const explicitlyMapped = mappings?.[normalized];
    if (explicitlyMapped && availableIds.has(explicitlyMapped)) return explicitlyMapped;
    const directMatch = availableByName.get(normalized);
    if (directMatch) return directMatch;
  }

  return '';
}
