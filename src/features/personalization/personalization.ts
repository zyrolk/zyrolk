import { Product } from '../../types';
import { selectRelatedProducts } from '../product-experience/productExperience';

export interface WishlistProductView {
  id: string;
  savedProduct: Product;
  product: Product;
  isAvailable: boolean;
  priceChange: 'decreased' | 'increased' | 'unchanged';
  priceDifference: number;
  priceChangePercent: number;
}

export interface CompareToggleResult {
  ids: string[];
  outcome: 'added' | 'removed' | 'limit-reached' | 'invalid';
}

export interface ComparisonRow {
  key: string;
  label: string;
  values: string[];
  different: boolean;
}

export interface RecommendationSection {
  id: 'related' | 'brand' | 'category' | 'best-sellers' | 'trending' | 'new-arrivals' | 'frequently-bought-together';
  title: string;
  description: string;
  products: Product[];
  foundation?: boolean;
}

const cleanText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const normalized = (value: unknown): string => cleanText(value).toLocaleLowerCase('en');
const activeProducts = (products: readonly Product[]): Product[] => products.filter(product => product.isActive !== false);
const productBrand = (product: Product): string => normalized(product.specs?.Brand || product.specs?.brand);
const productCategory = (product: Product): string => normalized(product.category);

export function reconcileWishlistProducts(savedProducts: readonly Product[], products: readonly Product[]): WishlistProductView[] {
  const liveById = new Map(products.map(product => [product.id, product]));
  const seen = new Set<string>();
  return savedProducts.flatMap(savedProduct => {
    if (!savedProduct?.id || seen.has(savedProduct.id)) return [];
    seen.add(savedProduct.id);
    const liveProduct = liveById.get(savedProduct.id);
    const product = liveProduct || savedProduct;
    const savedPrice = Number(savedProduct.price);
    const livePrice = Number(product.price);
    const priceDifference = Number.isFinite(savedPrice) && Number.isFinite(livePrice) ? livePrice - savedPrice : 0;
    const priceChange = priceDifference < 0 ? 'decreased' : priceDifference > 0 ? 'increased' : 'unchanged';
    return [{
      id: savedProduct.id,
      savedProduct,
      product,
      isAvailable: Boolean(liveProduct && liveProduct.isActive !== false),
      priceChange,
      priceDifference: Math.abs(priceDifference),
      priceChangePercent: savedPrice > 0 ? Math.abs((priceDifference / savedPrice) * 100) : 0,
    }];
  });
}

export function mergeRecentlyViewedIds(localIds: readonly string[], cloudIds: readonly string[], limit = 24): string[] {
  const seen = new Set<string>();
  return [...localIds, ...cloudIds].flatMap(value => {
    const id = cleanText(value);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  }).slice(0, Math.max(1, limit));
}

export function cleanRecentlyViewedIds(ids: readonly string[], products: readonly Product[], limit = 24): string[] {
  const activeIds = new Set(activeProducts(products).map(product => product.id));
  const seen = new Set<string>();
  return ids.flatMap(value => {
    const id = cleanText(value);
    if (!id || seen.has(id) || !activeIds.has(id)) return [];
    seen.add(id);
    return [id];
  }).slice(0, Math.max(1, limit));
}

export function toggleCompareProduct(ids: readonly string[], productId: string, limit = 4): CompareToggleResult {
  const id = cleanText(productId);
  const uniqueIds = Array.from(new Set(ids.map(cleanText).filter(Boolean))).slice(0, Math.max(1, limit));
  if (!id) return { ids: uniqueIds, outcome: 'invalid' };
  if (uniqueIds.includes(id)) return { ids: uniqueIds.filter(candidate => candidate !== id), outcome: 'removed' };
  if (uniqueIds.length >= limit) return { ids: uniqueIds, outcome: 'limit-reached' };
  return { ids: [...uniqueIds, id], outcome: 'added' };
}

export function resolveComparedProducts(ids: readonly string[], products: readonly Product[], limit = 4): Product[] {
  const liveById = new Map(activeProducts(products).map(product => [product.id, product]));
  return ids.map(id => liveById.get(id)).filter((product): product is Product => Boolean(product)).slice(0, Math.max(1, limit));
}

const comparisonValue = (product: Product, key: string): string => {
  if (key === 'price') return Number.isFinite(product.price) ? `LKR ${product.price.toLocaleString('en-LK')}` : 'Not available';
  if (key === 'availability') return product.stock <= 0 ? 'Out of stock' : product.stock <= 5 ? `Low stock (${product.stock})` : `In stock (${product.stock})`;
  if (key === 'category') return cleanText(product.category) || 'Not available';
  if (key === 'brand') return cleanText(product.specs?.Brand || product.specs?.brand) || 'Not specified';
  const sourceEntry = Object.entries(product.specs || {}).find(([sourceKey]) => normalized(sourceKey).replace(/[_-]+/gu, ' ') === key);
  return cleanText(sourceEntry?.[1]) || 'Not specified';
};

const comparisonLabel = (key: string): string => key.replace(/\b\w/gu, letter => letter.toUpperCase());

export function buildComparisonRows(products: readonly Product[]): ComparisonRow[] {
  const specificationKeys = new Set<string>();
  products.forEach(product => Object.keys(product.specs || {}).forEach(key => {
    const normalizedKey = normalized(key).replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ');
    if (normalizedKey && normalizedKey !== 'brand') specificationKeys.add(normalizedKey);
  }));
  return ['price', 'availability', 'category', 'brand', ...Array.from(specificationKeys).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))]
    .map(key => {
      const values = products.map(product => comparisonValue(product, key));
      return { key, label: comparisonLabel(key), values, different: new Set(values.map(normalized)).size > 1 };
    });
}

const rankByEngagement = (left: Product, right: Product): number => (
  Number(right.isFeatured) - Number(left.isFeatured) ||
  right.reviewsCount - left.reviewsCount ||
  right.rating - left.rating ||
  left.id.localeCompare(right.id)
);

const rankByNewest = (left: Product, right: Product): number => (
  Number(right.isNew) - Number(left.isNew) ||
  new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime() ||
  left.id.localeCompare(right.id)
);

const withoutIds = (products: readonly Product[], excludedIds: Set<string>): Product[] => products.filter(product => !excludedIds.has(product.id));

export function buildPersonalizedRecommendations(input: {
  products: readonly Product[];
  wishlist: readonly Product[];
  recentlyViewed: readonly Product[];
  limit?: number;
}): RecommendationSection[] {
  const limit = Math.max(1, input.limit ?? 8);
  const available = activeProducts(input.products);
  const focus = input.recentlyViewed[0] || input.wishlist[0] || null;
  const excludedIds = new Set([...input.wishlist, ...input.recentlyViewed].map(product => product.id));
  const candidates = withoutIds(available, excludedIds);
  const brand = focus ? productBrand(focus) : '';
  const category = focus ? productCategory(focus) : '';

  const related = focus ? selectRelatedProducts(focus, candidates, limit) : [];
  const similarBrand = brand ? candidates.filter(product => productBrand(product) === brand).sort(rankByEngagement).slice(0, limit) : [];
  const similarCategory = category ? candidates.filter(product => productCategory(product) === category).sort(rankByEngagement).slice(0, limit) : [];
  const bestSellers = candidates.filter(product => product.isBestSeller === true).sort(rankByEngagement).slice(0, limit);
  const trending = candidates.filter(product => product.isFeatured === true || product.reviewsCount > 0).sort(rankByEngagement).slice(0, limit);
  const newArrivals = candidates.filter(product => product.isNew === true || Boolean(product.createdAt)).sort(rankByNewest).slice(0, limit);

  return [
    { id: 'related', title: 'Related Products', description: focus ? `Based on ${focus.name}.` : 'Open or save products to personalize this shelf.', products: related },
    { id: 'brand', title: 'Similar Brand', description: brand ? `More live products from ${cleanText(focus?.specs?.Brand || focus?.specs?.brand)}.` : 'Brand recommendations appear when live product specifications include a brand.', products: similarBrand },
    { id: 'category', title: 'Similar Category', description: category ? `More from ${cleanText(focus?.category)}.` : 'Category recommendations appear after you view or save a product.', products: similarCategory },
    { id: 'best-sellers', title: 'Best Sellers', description: 'Products explicitly marked as best sellers in the live catalogue.', products: bestSellers },
    { id: 'trending', title: 'Trending Products', description: 'Ranked from live featured and customer review activity.', products: trending },
    { id: 'new-arrivals', title: 'New Arrivals', description: 'Recently published or explicitly marked new in the live catalogue.', products: newArrivals },
    { id: 'frequently-bought-together', title: 'Frequently Bought Together', description: 'Privacy-safe co-purchase recommendations will appear when aggregate purchase signals are available.', products: [], foundation: true },
  ];
}
