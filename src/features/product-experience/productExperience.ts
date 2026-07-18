import { Product } from '../../types';

const PRODUCT_IMAGE_UNAVAILABLE_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
    <rect width="1200" height="1200" fill="#f8fafc"/>
    <g fill="none" stroke="#94a3b8" stroke-linecap="round" stroke-linejoin="round" stroke-width="32">
      <rect x="330" y="310" width="540" height="430" rx="36"/>
      <path d="m380 680 145-150 105 105 78-78 112 123"/>
      <circle cx="700" cy="440" r="54"/>
      <path d="m390 830 420-420"/>
    </g>
    <text x="600" y="900" fill="#64748b" font-family="Arial, sans-serif" font-size="52" text-anchor="middle">Image unavailable</text>
  </svg>`;

export const PRODUCT_IMAGE_FALLBACK = `data:image/svg+xml,${encodeURIComponent(PRODUCT_IMAGE_UNAVAILABLE_SVG)}`;

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
  if (data.verifiedPurchase !== true || !productId || !comment || !Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) return null;
  return {
    id,
    productId,
    customerName: cleanString(data.customerName),
    rating: numericRating,
    comment,
    createdAt: cleanString(data.createdAt),
  };
};

export const calculateReviewSummary = (reviews: readonly ProductReviewView[]) => {
  const distribution = [0, 0, 0, 0, 0];
  let total = 0;
  reviews.forEach((review) => {
    distribution[review.rating - 1] += 1;
    total += review.rating;
  });
  return { average: reviews.length ? total / reviews.length : 0, distribution, count: reviews.length };
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
