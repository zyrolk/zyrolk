import {
  collection,
  documentId,
  Firestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { Category, Product } from '../../types';
import { ProductionReview, projectProductionReview } from '../../features/reviews/reviewModel';
import { isProductExplicitlyActive, normalizeStorefrontStock } from './productAvailability';
import { fetchJson } from '../network/fetchJson';

export const STOREFRONT_PRODUCT_PAGE_SIZE = 24;
export const STOREFRONT_CATEGORY_LIMIT = 100;
export const HOMEPAGE_REVIEW_LIMIT = 6;
export interface StorefrontProductPage {
  products: Product[];
  cursor: string | null;
  hasMore: boolean;
}

export interface StorefrontCatalogCounts {
  activeProducts: number;
  byCategory: Record<string, number>;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const isSupplierTaxonomyCategoryId = (value: unknown): boolean => (
  typeof value === 'string' && /^supplier-taxonomy(?:-sub)?-/iu.test(value.trim())
);
export const sanitizeStorefrontCategoryId = (value: unknown): string => {
  const result = text(value);
  return isSupplierTaxonomyCategoryId(result) ? '' : result;
};
export const isPublicStorefrontCategory = (category: Category): boolean => (
  category.isActive !== false
  && (category as Category & { taxonomyCandidate?: unknown }).taxonomyCandidate !== true
);
const finiteNumber = (value: unknown, fallback = 0): number => {
  const resolved = Number(value);
  return Number.isFinite(resolved) ? resolved : fallback;
};
const textList = (value: unknown): string[] => Array.isArray(value)
  ? value.map(text).filter(Boolean)
  : [];
const optionalText = (value: unknown): string | undefined => text(value) || undefined;
const optionalNumber = (value: unknown): number | undefined => {
  const resolved = Number(value);
  return Number.isFinite(resolved) ? resolved : undefined;
};
const timestampText = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const resolved = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(resolved.getTime()) ? resolved.toISOString() : undefined;
  }
  return undefined;
};
const publicSpecifications = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key.trim(), text(entry)] as const)
    .filter(([key, entry]) => Boolean(key && entry)));
};

const STOREFRONT_TARGETED_READ_CONCURRENCY = 8;

/**
 * Projects a public product document through an explicit customer-safe boundary.
 * Commercial and supplier-only fields are intentionally never copied.
 */
export const projectStorefrontProduct = (id: string, data: Record<string, unknown>): Product => {
  const category = sanitizeStorefrontCategoryId(data.category);
  return {
  id,
  name: text(data.name),
  description: text(data.description),
  price: Math.max(0, finiteNumber(data.price)),
  originalPrice: optionalNumber(data.originalPrice),
  discount: optionalNumber(data.discount),
  imageUrl: text(data.imageUrl),
  imageUrls: textList(data.imageUrls),
  category,
  subcategory: category ? optionalText(sanitizeStorefrontCategoryId(data.subcategory)) : undefined,
  brand: optionalText(data.brand),
  model: optionalText(data.model),
  barcode: optionalText(data.barcode),
  productType: optionalText(data.productType),
  tags: textList(data.tags),
  shortDescription: optionalText(data.shortDescription),
  keyFeatures: textList(data.keyFeatures),
  whatsIncluded: textList(data.whatsIncluded),
  rating: Math.min(5, Math.max(0, finiteNumber(data.rating))),
  reviewsCount: Math.max(0, Math.trunc(finiteNumber(data.reviewsCount))),
  isNew: data.isNew === true,
  isFeatured: data.isFeatured === true,
  isBestSeller: data.isBestSeller === true,
  isActive: isProductExplicitlyActive(data.isActive),
  stock: normalizeStorefrontStock(data.stock),
  specs: publicSpecifications(data.specs),
  createdAt: timestampText(data.createdAt),
  updatedAt: timestampText(data.updatedAt),
  };
};

export const mergeStorefrontProducts = (
  current: readonly Product[],
  incoming: readonly Product[],
): Product[] => {
  const merged = new Map(current.map((product) => [product.id, product]));
  incoming.forEach((product) => merged.set(product.id, product));
  return [...merged.values()];
};

interface PublicCatalogPageResponse {
  products: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
}

interface PublicCatalogProductsResponse {
  products: Array<Record<string, unknown>>;
}

interface PublicCatalogCountsResponse extends StorefrontCatalogCounts {}

const projectApiProducts = (records: readonly Record<string, unknown>[]): Product[] => records.flatMap((record) => {
  const id = text(record.id);
  if (!id) return [];
  const product = projectStorefrontProduct(id, record);
  return isProductExplicitlyActive(product.isActive) ? [product] : [];
});

const loadPublicCatalogPage = async (after?: string | null): Promise<StorefrontProductPage> => {
  const parameters = new URLSearchParams({ limit: String(STOREFRONT_PRODUCT_PAGE_SIZE) });
  if (after) parameters.set('after', after);
  const response = await fetchJson<PublicCatalogPageResponse>(`/api/catalog/products?${parameters.toString()}`);
  return {
    products: projectApiProducts(response.products),
    cursor: typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : null,
    hasMore: response.hasMore === true,
  };
};

export const subscribeToStorefrontProductPage = (
  _firestore: Firestore,
  onPage: (page: StorefrontProductPage) => void,
  onError: (error: unknown) => void,
): (() => void) => {
  let cancelled = false;
  void loadPublicCatalogPage()
    .then((page) => {
      if (!cancelled) onPage(page);
    })
    .catch((error) => {
      if (!cancelled) onError(error);
    });
  return () => { cancelled = true; };
};

export const loadNextStorefrontProductPage = async (
  _firestore: Firestore,
  cursor: string,
): Promise<StorefrontProductPage> => loadPublicCatalogPage(cursor);

export const loadStorefrontProductsByIdsWithReader = async (
  ids: readonly string[],
  readProduct: (id: string) => Promise<Product | null>,
): Promise<Product[]> => {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const results: Array<Product | null> = Array(uniqueIds.length).fill(null);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < uniqueIds.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await readProduct(uniqueIds[currentIndex]);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(STOREFRONT_TARGETED_READ_CONCURRENCY, uniqueIds.length) },
      () => worker(),
    ),
  );

  return results.filter((product): product is Product => product !== null);
};

export const loadStorefrontProductsByIds = async (
  _firestore: Firestore,
  ids: readonly string[],
): Promise<Product[]> => {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const response = await fetchJson<PublicCatalogProductsResponse>(
    `/api/catalog/products/by-ids?ids=${encodeURIComponent(uniqueIds.join(','))}`,
  );
  return projectApiProducts(response.products);
};

export const loadStorefrontHomepageProducts = async (_firestore: Firestore): Promise<Product[]> => {
  const response = await fetchJson<PublicCatalogProductsResponse>('/api/catalog/products/homepage');
  return projectApiProducts(response.products);
};

export const loadStorefrontCatalogCounts = async (
  _firestore: Firestore,
  categories: readonly Category[],
): Promise<StorefrontCatalogCounts> => {
  const categoryIds = categories.filter(isPublicStorefrontCategory).map((category) => category.id);
  const response = await fetchJson<PublicCatalogCountsResponse>(
    `/api/catalog/counts?categoryIds=${encodeURIComponent(categoryIds.join(','))}`,
  );
  return {
    activeProducts: Number.isFinite(response.activeProducts) ? response.activeProducts : 0,
    byCategory: response.byCategory || {},
  };
};

export const subscribeToStorefrontCategories = (
  firestore: Firestore,
  onCategories: (categories: Category[]) => void,
  onError: (error: unknown) => void,
): (() => void) => onSnapshot(
  query(
    collection(firestore, 'categories'),
    orderBy(documentId()),
    limit(STOREFRONT_CATEGORY_LIMIT),
  ),
  (snapshot) => onCategories(snapshot.docs
    .filter((document) => document.data().taxonomyCandidate !== true)
    .map((document) => ({
      id: document.id,
      ...document.data(),
    } as Category))),
  onError,
);

export const subscribeToHomepageReviews = (
  firestore: Firestore,
  onReviews: (reviews: ProductionReview[]) => void,
  onError: (error: unknown) => void,
): (() => void) => onSnapshot(
  query(
    collection(firestore, 'reviews'),
    where('approved', '==', true),
    orderBy('createdAt', 'desc'),
    limit(HOMEPAGE_REVIEW_LIMIT),
  ),
  (snapshot) => onReviews(snapshot.docs.flatMap((document) => {
    const review = projectProductionReview(document.id, document.data());
    return review ? [review] : [];
  })),
  onError,
);
