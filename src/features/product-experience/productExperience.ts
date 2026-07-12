import { Product } from '../../types';

export const PRODUCT_IMAGE_FALLBACK = 'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=1200&q=80';

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const buildProductGallery = (product: Pick<Product, 'imageUrl' | 'imageUrls'>): string[] => {
  const images = [product.imageUrl, ...(Array.isArray(product.imageUrls) ? product.imageUrls : [])]
    .map(cleanString)
    .filter(Boolean);
  return images.length > 0 ? Array.from(new Set(images)) : [PRODUCT_IMAGE_FALLBACK];
};

export const clampGalleryIndex = (index: number, imageCount: number): number => {
  if (!Number.isFinite(index) || imageCount <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), imageCount - 1);
};

export interface SpecificationGroup {
  title: string;
  entries: Array<{ label: string; value: string }>;
}

const SPECIFICATION_ORDER = [
  'brand', 'model', 'type', 'color', 'colour', 'display', 'screen size', 'processor',
  'memory', 'ram', 'storage', 'battery', 'capacity', 'connectivity', 'warranty',
];

const normalizeSpecificationKey = (key: string): string => key.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const specificationLabel = (key: string): string => key.replace(/\b\w/g, (letter) => letter.toUpperCase());

export const groupProductSpecifications = (specs: Record<string, string> | null | undefined): SpecificationGroup[] => {
  const sourceEntries = Object.entries(specs || {});
  const normalized = sourceEntries
    .map(([key, value], sourceIndex) => ({ key: normalizeSpecificationKey(key), value: cleanString(value), sourceIndex }))
    .filter((entry) => entry.key && entry.value);

  const known = normalized
    .filter((entry) => SPECIFICATION_ORDER.includes(entry.key))
    .sort((a, b) => SPECIFICATION_ORDER.indexOf(a.key) - SPECIFICATION_ORDER.indexOf(b.key) || a.sourceIndex - b.sourceIndex);
  const additional = normalized
    .filter((entry) => !SPECIFICATION_ORDER.includes(entry.key))
    .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));

  return [
    known.length ? { title: 'Key Specifications', entries: known.map(({ key, value }) => ({ label: specificationLabel(key), value })) } : null,
    additional.length ? { title: 'Additional Details', entries: additional.map(({ key, value }) => ({ label: specificationLabel(key), value })) } : null,
  ].filter((group): group is SpecificationGroup => group !== null);
};

const normalizedCategory = (product: Product): string => cleanString(product.category).toLowerCase();
const normalizedBrand = (product: Product): string => cleanString(product.specs?.Brand || product.specs?.brand).toLowerCase();

export const selectRelatedProducts = (product: Product, allProducts: readonly Product[], limit = 8): Product[] => {
  const category = normalizedCategory(product);
  const brand = normalizedBrand(product);
  return allProducts
    .filter((candidate) => candidate.id !== product.id && candidate.isActive !== false)
    .map((candidate, sourceIndex) => {
      const sameCategory = normalizedCategory(candidate) === category;
      const sameBrand = Boolean(brand) && normalizedBrand(candidate) === brand;
      const priceDistance = Math.abs(Number(candidate.price) - Number(product.price));
      return { candidate, sourceIndex, sameCategory, sameBrand, priceDistance };
    })
    .sort((a, b) =>
      Number(b.sameCategory) - Number(a.sameCategory) ||
      Number(b.sameBrand) - Number(a.sameBrand) ||
      a.priceDistance - b.priceDistance ||
      b.candidate.rating - a.candidate.rating ||
      a.candidate.id.localeCompare(b.candidate.id) ||
      a.sourceIndex - b.sourceIndex
    )
    .slice(0, Math.max(0, limit))
    .map(({ candidate }) => candidate);
};

export interface ProductReviewView {
  id: string;
  productId: string;
  customerName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export const projectProductReview = (id: string, data: Record<string, unknown>): ProductReviewView | null => {
  const productId = cleanString(data.productId);
  const comment = cleanString(data.comment);
  const numericRating = Number(data.rating);
  if (!productId || !comment || !Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) return null;
  return {
    id,
    productId,
    customerName: cleanString(data.customerName) || cleanString(data.userName) || 'Authenticated Customer',
    rating: numericRating,
    comment,
    createdAt: cleanString(data.createdAt),
  };
};

export const calculateReviewSummary = (reviews: readonly ProductReviewView[], fallbackRating = 0) => {
  const distribution = [0, 0, 0, 0, 0];
  let total = 0;
  reviews.forEach((review) => {
    distribution[review.rating - 1] += 1;
    total += review.rating;
  });
  return { average: reviews.length ? total / reviews.length : fallbackRating, distribution, count: reviews.length };
};

export class LatestRequestGate {
  private requestId = 0;
  begin(): number { this.requestId += 1; return this.requestId; }
  isLatest(id: number): boolean { return id === this.requestId; }
}

export class SubmissionGuard {
  private active = false;
  begin(): boolean { if (this.active) return false; this.active = true; return true; }
  end(): void { this.active = false; }
}

export const nextGalleryIndexForKey = (key: string, current: number, count: number): number => {
  if (count <= 1) return clampGalleryIndex(current, count);
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  return clampGalleryIndex(current, count);
};

export const getDialogEscapeAction = (lightboxOpen: boolean): 'close-lightbox' | 'close-modal' =>
  lightboxOpen ? 'close-lightbox' : 'close-modal';

export const getFocusWrapIndex = (shiftKey: boolean, activeIndex: number, count: number): number | null => {
  if (count <= 0) return null;
  if (shiftKey && activeIndex === 0) return count - 1;
  if (!shiftKey && activeIndex === count - 1) return 0;
  return null;
};
