import type { Brand, Category, Product, SpecificationTemplateField, SubCategory } from '../../types';
import { resolveRegisteredBrandId } from '../brands/brandUtils';
import { categoryMatches, normalizeCategoryName, normalizeCategorySlug } from '../categories/categoryUtils';

const normalizeTextList = (values: readonly string[] | undefined): string[] => {
  const normalized = (values ?? [])
    .map((value) => value.normalize('NFKC').trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  return [...new Set(normalized)];
};

export const normalizeSubcategories = (values: readonly SubCategory[] | undefined): SubCategory[] => {
  const seen = new Set<string>();
  const result: SubCategory[] = [];
  for (const value of values ?? []) {
    const id = normalizeCategorySlug(value.id || value.name);
    const name = normalizeCategoryName(value.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name, isActive: value.isActive !== false });
  }
  return result;
};

export const normalizeSpecificationTemplate = (
  values: readonly SpecificationTemplateField[] | undefined,
): SpecificationTemplateField[] => {
  const seen = new Set<string>();
  const result: SpecificationTemplateField[] = [];
  for (const value of values ?? []) {
    const name = normalizeCategoryName(value.name);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, required: value.required === true });
  }
  return result;
};

export const normalizeCategoryBlueprint = (category: Readonly<Category>): Category => ({
  ...category,
  subcategories: normalizeSubcategories(category.subcategories),
  specificationTemplate: normalizeSpecificationTemplate(category.specificationTemplate),
});

export const getSelectedCategory = (
  categories: readonly Readonly<Category>[],
  categoryId: string | undefined,
): Readonly<Category> | undefined => categories.find((category) => categoryMatches(category.id, categoryId ?? ''));

export const getActiveSubcategories = (category: Readonly<Category> | undefined): SubCategory[] =>
  normalizeSubcategories(category?.subcategories).filter((subcategory) => subcategory.isActive !== false);

export const applySpecificationTemplate = (
  specs: Readonly<Record<string, string>> | undefined,
  template: readonly Readonly<SpecificationTemplateField>[] | undefined,
): Record<string, string> => {
  const result = { ...(specs ?? {}) };
  for (const field of normalizeSpecificationTemplate(template)) {
    if (!(field.name in result)) result[field.name] = '';
  }
  return result;
};

export const createProductDraft = (
  categoryId: string,
  sku: string,
): Partial<Product> => ({
  id: '',
  name: '',
  description: '',
  shortDescription: '',
  price: 0,
  originalPrice: 0,
  imageUrl: '',
  imageUrls: [],
  category: categoryId,
  subcategory: '',
  brand: '',
  model: '',
  barcode: '',
  productType: '',
  tags: [],
  keyFeatures: [],
  whatsIncluded: [],
  stock: 10,
  specs: {},
  isNew: false,
  isFeatured: false,
  isBestSeller: false,
  isActive: true,
  sku,
  supplierItemCode: '',
  costPrice: undefined,
  marketPrice: undefined,
});

export const normalizeProductForEditor = (
  product: Readonly<Product>,
  brands: readonly Readonly<Brand>[],
  categories: readonly Readonly<Category>[],
): Partial<Product> => {
  const category = getSelectedCategory(categories, product.category);
  return {
    ...product,
    brand: resolveRegisteredBrandId(product, brands),
    subcategory: getActiveSubcategories(category).some((item) => item.id === product.subcategory)
      ? product.subcategory
      : '',
    tags: normalizeTextList(product.tags),
    keyFeatures: normalizeTextList(product.keyFeatures),
    whatsIncluded: normalizeTextList(product.whatsIncluded),
    imageUrls: normalizeTextList(product.imageUrls),
    specs: applySpecificationTemplate(product.specs, category?.specificationTemplate),
  };
};

export interface ProductSavePayloadInput {
  readonly draft: Partial<Product>;
  readonly storedProduct?: Readonly<Product> | null;
  readonly selectedBrand?: Readonly<Brand>;
  readonly now: string;
}

export const buildProductSavePayload = ({
  draft,
  storedProduct,
  selectedBrand,
  now,
}: ProductSavePayloadInput): Partial<Product> => {
  const sellingPrice = Number(draft.price);
  const originalPrice = draft.originalPrice ? Number(draft.originalPrice) : undefined;
  const discount = originalPrice && originalPrice > sellingPrice
    ? Math.round(((originalPrice - sellingPrice) / originalPrice) * 100)
    : undefined;
  const specs = Object.fromEntries(
    Object.entries(draft.specs ?? {})
      .map(([key, value]) => [normalizeCategoryName(key), String(value).trim()] as const)
      .filter(([key]) => Boolean(key)),
  );
  if (selectedBrand) specs.Brand = selectedBrand.name;
  if (draft.model?.trim()) specs.Model = draft.model.trim();

  return {
    ...draft,
    id: storedProduct?.id ?? draft.id?.trim(),
    name: draft.name?.trim(),
    description: draft.description?.trim() ?? '',
    shortDescription: draft.shortDescription?.trim() || undefined,
    brand: draft.brand?.trim() || undefined,
    model: draft.model?.trim() || undefined,
    barcode: draft.barcode?.trim() || undefined,
    productType: draft.productType?.trim() || undefined,
    subcategory: draft.subcategory?.trim() || undefined,
    tags: normalizeTextList(draft.tags),
    keyFeatures: normalizeTextList(draft.keyFeatures),
    whatsIncluded: normalizeTextList(draft.whatsIncluded),
    price: sellingPrice,
    originalPrice,
    discount,
    stock: Number(draft.stock),
    imageUrl: draft.imageUrl?.trim(),
    imageUrls: normalizeTextList(draft.imageUrls),
    specs,
    rating: storedProduct?.rating ?? 0,
    reviewsCount: storedProduct?.reviewsCount ?? 0,
    createdAt: storedProduct?.createdAt ?? now,
    updatedAt: now,
    isActive: draft.isActive !== false,
    sku: storedProduct?.sku ?? draft.sku?.trim(),
  };
};
