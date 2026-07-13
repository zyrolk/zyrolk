import { Category } from '../types';

export type SupplierCategoryMappings = Record<string, string>;

export const normalizeSupplierCategory = (value: unknown): string => String(value || '')
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase('en')
  .replace(/[\s_-]+/g, ' ');

export function parseSupplierCategoryMappings(value: string): SupplierCategoryMappings {
  return value.split(/\r?\n/).reduce<SupplierCategoryMappings>((mappings, line) => {
    const separator = line.indexOf('=');
    if (separator < 1) return mappings;
    const supplierCategory = normalizeSupplierCategory(line.slice(0, separator));
    const storeCategoryId = line.slice(separator + 1).trim();
    if (supplierCategory && storeCategoryId) mappings[supplierCategory] = storeCategoryId;
    return mappings;
  }, {});
}

export function formatSupplierCategoryMappings(mappings: SupplierCategoryMappings | undefined): string {
  return Object.entries(mappings || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([supplierCategory, storeCategoryId]) => `${supplierCategory}=${storeCategoryId}`)
    .join('\n');
}

export function resolveSupplierCategory(
  supplierCategories: readonly string[] | undefined,
  storeCategories: readonly Pick<Category, 'id' | 'name'>[],
  mappings: SupplierCategoryMappings | undefined,
): string {
  const availableById = new Map(storeCategories.map((category) => [category.id, category.id]));
  const availableByName = new Map<string, string>();
  storeCategories.forEach((category) => {
    availableByName.set(normalizeSupplierCategory(category.id), category.id);
    availableByName.set(normalizeSupplierCategory(category.name), category.id);
  });

  for (const supplierCategory of supplierCategories || []) {
    const normalized = normalizeSupplierCategory(supplierCategory);
    const explicitlyMapped = mappings?.[normalized];
    if (explicitlyMapped && availableById.has(explicitlyMapped)) return explicitlyMapped;
    const directMatch = availableByName.get(normalized);
    if (directMatch) return directMatch;
  }

  return '';
}
