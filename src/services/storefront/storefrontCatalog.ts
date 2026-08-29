import {
  collection,
  documentId,
  Firestore,
  getCountFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  QueryDocumentSnapshot,
  startAfter,
  where,
} from 'firebase/firestore';
import { Category, Product } from '../../types';
import { ProductionReview, projectProductionReview } from '../../features/reviews/reviewModel';
import { isProductExplicitlyActive } from './productAvailability';

export const STOREFRONT_PRODUCT_PAGE_SIZE = 24;
export const STOREFRONT_CATEGORY_LIMIT = 100;
export const HOMEPAGE_REVIEW_LIMIT = 6;
const FIRESTORE_IN_QUERY_LIMIT = 30;

export interface StorefrontProductPage {
  products: Product[];
  cursor: QueryDocumentSnapshot | null;
  hasMore: boolean;
}

export interface StorefrontCatalogCounts {
  activeProducts: number;
  byCategory: Record<string, number>;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
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

/**
 * Projects a public product document through an explicit customer-safe boundary.
 * Commercial and supplier-only fields are intentionally never copied.
 */
export const projectStorefrontProduct = (id: string, data: Record<string, unknown>): Product => ({
  id,
  name: text(data.name),
  description: text(data.description),
  price: Math.max(0, finiteNumber(data.price)),
  originalPrice: optionalNumber(data.originalPrice),
  discount: optionalNumber(data.discount),
  imageUrl: text(data.imageUrl),
  imageUrls: textList(data.imageUrls),
  category: text(data.category),
  subcategory: optionalText(data.subcategory),
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
  stock: Math.max(0, Math.trunc(finiteNumber(data.stock))),
  specs: publicSpecifications(data.specs),
  createdAt: timestampText(data.createdAt),
  updatedAt: timestampText(data.updatedAt),
});

export const mergeStorefrontProducts = (
  current: readonly Product[],
  incoming: readonly Product[],
): Product[] => {
  const merged = new Map(current.map((product) => [product.id, product]));
  incoming.forEach((product) => merged.set(product.id, product));
  return [...merged.values()];
};

const pageFromDocuments = (documents: QueryDocumentSnapshot[]): StorefrontProductPage => ({
  products: documents.map((document) => projectStorefrontProduct(document.id, document.data())),
  cursor: documents.at(-1) || null,
  hasMore: documents.length === STOREFRONT_PRODUCT_PAGE_SIZE,
});

export const subscribeToStorefrontProductPage = (
  firestore: Firestore,
  onPage: (page: StorefrontProductPage) => void,
  onError: (error: unknown) => void,
): (() => void) => onSnapshot(
  query(
    collection(firestore, 'products'),
    where('isActive', '==', true),
    orderBy(documentId()),
    limit(STOREFRONT_PRODUCT_PAGE_SIZE),
  ),
  (snapshot) => onPage(pageFromDocuments(snapshot.docs)),
  onError,
);

export const loadNextStorefrontProductPage = async (
  firestore: Firestore,
  cursor: QueryDocumentSnapshot,
): Promise<StorefrontProductPage> => {
  const snapshot = await getDocs(query(
    collection(firestore, 'products'),
    where('isActive', '==', true),
    orderBy(documentId()),
    startAfter(cursor),
    limit(STOREFRONT_PRODUCT_PAGE_SIZE),
  ));
  return pageFromDocuments(snapshot.docs);
};

export const loadStorefrontProductsByIds = async (
  firestore: Firestore,
  ids: readonly string[],
): Promise<Product[]> => {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const products: Product[] = [];
  for (let index = 0; index < uniqueIds.length; index += FIRESTORE_IN_QUERY_LIMIT) {
    const chunk = uniqueIds.slice(index, index + FIRESTORE_IN_QUERY_LIMIT);
    const snapshot = await getDocs(query(
      collection(firestore, 'products'),
      where(documentId(), 'in', chunk),
      limit(FIRESTORE_IN_QUERY_LIMIT),
    ));
    snapshot.docs.forEach((document) => products.push(projectStorefrontProduct(document.id, document.data())));
  }
  return products;
};

export const loadStorefrontHomepageProducts = async (firestore: Firestore): Promise<Product[]> => {
  const snapshots = await Promise.all([
    getDocs(query(collection(firestore, 'products'), where('isActive', '==', true), where('isFeatured', '==', true), limit(16))),
    getDocs(query(collection(firestore, 'products'), where('isActive', '==', true), where('isNew', '==', true), limit(16))),
    getDocs(query(collection(firestore, 'products'), where('isActive', '==', true), where('isBestSeller', '==', true), limit(16))),
    getDocs(query(collection(firestore, 'products'), where('isActive', '==', true), where('discount', '>', 0), limit(16))),
  ]);
  return mergeStorefrontProducts([], snapshots.flatMap((snapshot) => snapshot.docs.map((document) => (
    projectStorefrontProduct(document.id, document.data())
  ))));
};

export const loadStorefrontCatalogCounts = async (
  firestore: Firestore,
  categories: readonly Category[],
): Promise<StorefrontCatalogCounts> => {
  const activeProductsQuery = query(collection(firestore, 'products'), where('isActive', '==', true));
  const [activeProducts, categoryEntries] = await Promise.all([
    getCountFromServer(activeProductsQuery),
    Promise.all(categories.map(async (category) => {
      const countSnapshot = await getCountFromServer(query(
        collection(firestore, 'products'),
        where('category', '==', category.id),
        where('isActive', '==', true),
      ));
      return [category.id, countSnapshot.data().count] as const;
    })),
  ]);
  return {
    activeProducts: activeProducts.data().count,
    byCategory: Object.fromEntries(categoryEntries),
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
  (snapshot) => onCategories(snapshot.docs.map((document) => ({
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
