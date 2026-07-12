import type { Category, Product } from '../../types';

export interface CategoryProductCounts {
  readonly active: number;
  readonly total: number;
}

export const DEFAULT_CATEGORY_IMAGE = 'https://images.unsplash.com/photo-1468495244123-6c6c332eeece?q=80&w=600&auto=format&fit=crop';

export const normalizeCategoryName = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

export const normalizeCategorySlug = (value: string): string =>
  value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');

export const normalizeCategoryId = (value: string): string => normalizeCategorySlug(value);

export const sortCategoriesAlphabetically = <T extends Readonly<Category>>(categories: readonly T[]): T[] =>
  categories
    .map((category, index) => ({ category, index }))
    .sort((left, right) => {
      const comparison = normalizeCategoryName(left.category.name).localeCompare(
        normalizeCategoryName(right.category.name),
        'en',
        { sensitivity: 'base', numeric: true },
      );
      return comparison || left.index - right.index;
    })
    .map(({ category }) => category);

export const isDuplicateCategorySlug = (
  categories: readonly Readonly<Category>[],
  slug: string,
): boolean => {
  const normalizedSlug = normalizeCategorySlug(slug);
  return Boolean(normalizedSlug) && categories.some(
    (category) => normalizeCategoryId(category.id) === normalizedSlug,
  );
};

export const categoryMatches = (categoryId: string | undefined, selectedCategory: string): boolean =>
  normalizeCategoryId(categoryId ?? '') === normalizeCategoryId(selectedCategory);

export const buildCategoryProductCounts = (
  categories: readonly Readonly<Category>[],
  products: readonly Readonly<Product>[],
): Readonly<Record<string, CategoryProductCounts>> => {
  const counts: Record<string, CategoryProductCounts> = {};
  for (const category of categories) {
    const matchingProducts = products.filter((product) => categoryMatches(product.category, category.id));
    counts[category.id] = Object.freeze({
      active: matchingProducts.filter((product) => product.isActive !== false).length,
      total: matchingProducts.length,
    });
  }
  return Object.freeze(counts);
};

export const canDeleteCategory = (counts: CategoryProductCounts | undefined): boolean =>
  (counts?.total ?? 0) === 0;

export const resolveCategoryImage = (
  category: Readonly<Category>,
  products: readonly Readonly<Product>[],
  fallbackImages: Readonly<Record<string, string>>,
): string => {
  const storedImage = category.imageUrl?.trim();
  if (storedImage) return storedImage;
  const fallbackImage = fallbackImages[normalizeCategoryId(category.id)];
  if (fallbackImage) return fallbackImage;
  const productImage = products.find(
    (product) => categoryMatches(product.category, category.id) && Boolean(product.imageUrl?.trim()),
  )?.imageUrl;
  return productImage || DEFAULT_CATEGORY_IMAGE;
};
