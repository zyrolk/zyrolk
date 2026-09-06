import type { Brand, Category } from '../types';

export interface SupplierReviewCatalogTaxonomy {
  categories: Array<Category & { specificationTemplate?: Array<{ name: string; required?: boolean }> }>;
  brands: Brand[];
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const projectSubcategory = (value: unknown): Category['subcategories'][number] | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || '').trim();
  const name = String(record.name || '').trim();
  if (!id || !name) return null;
  return { id, name, isActive: record.isActive !== false };
};

const projectCategory = (value: unknown): Category | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || '').trim();
  const name = String(record.name || '').trim();
  if (!id || record.isActive === false) return null;
  const subcategories = Array.isArray(record.subcategories)
    ? record.subcategories.map(projectSubcategory).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  const specificationTemplate = Array.isArray(record.specificationTemplate)
    ? record.specificationTemplate
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const field = entry as Record<string, unknown>;
        const fieldName = String(field.name || '').trim();
        if (!fieldName) return null;
        return { name: fieldName, required: field.required === true };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  return {
    id,
    name: name || id,
    icon: String(record.icon || 'Layers'),
    isActive: record.isActive !== false,
    subcategories,
    specificationTemplate,
  };
};

const projectBrand = (value: unknown): Brand | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id || '').trim();
  const name = String(record.name || '').trim();
  if (!id || record.isActive === false) return null;
  return { id, name: name || id, isActive: record.isActive !== false };
};

export function projectSupplierReviewCatalogTaxonomy(payload: unknown): SupplierReviewCatalogTaxonomy {
  const root = asRecord(payload);
  const catalog = asRecord(root.catalog);
  const categories = (Array.isArray(catalog.categories) ? catalog.categories : [])
    .map(projectCategory)
    .filter((entry): entry is Category => Boolean(entry));
  const brands = (Array.isArray(catalog.brands) ? catalog.brands : [])
    .map(projectBrand)
    .filter((entry): entry is Brand => Boolean(entry));
  return { categories, brands };
}

export const supplierReviewValidCategoryIds = (categories: readonly Category[]): string[] => (
  categories.filter((category) => category.isActive !== false).map((category) => String(category.id))
);
