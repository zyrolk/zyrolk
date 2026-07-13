import { Product } from '../types';
import { normalizeSupplierProductImages } from './connectors/a2z-website/productImages';

export interface SupplierReviewSourceItem {
  id: string;
  productName: string;
  supplierCode: string;
  supplierName?: string;
  costPrice: number;
  marketPrice: number;
  stock: number;
  imageUrl?: string;
  sourceId?: string;
  batchId?: string;
  productPayload?: Product & Record<string, unknown>;
  supplierSnapshot?: Record<string, unknown>;
}

export interface SupplierReviewDraft {
  productName: string;
  sellingPrice: number;
  comparePrice: number;
  stock: number;
  category: string;
  brand: string;
  isActive: boolean;
}

export interface SupplierProfitMetrics {
  profit: number;
  marginPercent: number;
}

export interface SupplierReviewValidationErrors {
  productName?: string;
  sellingPrice?: string;
  comparePrice?: string;
  stock?: string;
  category?: string;
}

const finiteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function createSupplierReviewDraft(item: SupplierReviewSourceItem): SupplierReviewDraft {
  const payload = item.productPayload;
  const specs = payload?.specs || {};

  return {
    productName: String(payload?.name || item.productName || ''),
    sellingPrice: finiteNumber(payload?.price, finiteNumber(item.marketPrice)),
    comparePrice: finiteNumber(payload?.originalPrice, finiteNumber(item.marketPrice)),
    stock: Math.max(0, Math.floor(finiteNumber(payload?.stock, finiteNumber(item.stock)))),
    category: String(payload?.category || ''),
    brand: String(specs.brand || specs.Brand || ''),
    isActive: payload?.isActive !== false,
  };
}

export function calculateSupplierProfit(sellingPrice: number, wholesalePrice: number): SupplierProfitMetrics {
  const selling = finiteNumber(sellingPrice);
  const wholesale = finiteNumber(wholesalePrice);
  const profit = selling - wholesale;

  return {
    profit,
    marginPercent: selling > 0 ? (profit / selling) * 100 : 0,
  };
}

export function validateSupplierReviewDraft(draft: SupplierReviewDraft): SupplierReviewValidationErrors {
  const errors: SupplierReviewValidationErrors = {};

  if (!draft.productName.trim()) errors.productName = 'Product name is required.';
  if (!Number.isFinite(draft.sellingPrice) || draft.sellingPrice <= 0) errors.sellingPrice = 'Selling price must be greater than zero.';
  if (!Number.isFinite(draft.comparePrice) || draft.comparePrice < 0) errors.comparePrice = 'Compare price cannot be negative.';
  if (draft.comparePrice > 0 && draft.comparePrice < draft.sellingPrice) errors.comparePrice = 'Compare price must be at least the selling price.';
  if (!Number.isInteger(draft.stock) || draft.stock < 0) errors.stock = 'Stock must be a whole number of zero or more.';
  if (!draft.category.trim()) errors.category = 'Category is required.';

  return errors;
}

export function buildSupplierApprovalItem(
  item: SupplierReviewSourceItem,
  draft: SupplierReviewDraft,
): SupplierReviewSourceItem {
  const validationErrors = validateSupplierReviewDraft(draft);
  if (Object.keys(validationErrors).length > 0) {
    throw new Error('Review editor contains invalid product values.');
  }

  if (!item.productPayload?.id) {
    throw new Error(`Product payload not found for queue item: ${item.id}`);
  }

  const originalPayload = item.productPayload;
  const normalizedImages = normalizeSupplierProductImages(originalPayload.imageUrl, originalPayload.imageUrls);
  if (normalizedImages.length === 0) {
    throw new Error('A valid supplier product image is required before publishing. Sync the real supplier image and review the item again.');
  }
  const sellingPrice = finiteNumber(draft.sellingPrice);
  const comparePrice = finiteNumber(draft.comparePrice, sellingPrice);
  const normalizedComparePrice = comparePrice > 0 ? comparePrice : sellingPrice;
  const discount = normalizedComparePrice > sellingPrice
    ? Math.round(((normalizedComparePrice - sellingPrice) / normalizedComparePrice) * 100)
    : 0;
  const brand = draft.brand.trim();
  const supplierSnapshot = item.supplierSnapshot || {
    supplierName: item.supplierName || 'Unknown Supplier',
    supplierSku: item.supplierCode,
    wholesalePrice: finiteNumber(item.costPrice),
    recommendedRetailPrice: finiteNumber(item.marketPrice),
    stock: finiteNumber(item.stock),
    imageUrl: item.imageUrl || originalPayload.imageUrl || '',
    imageUrls: Array.isArray(originalPayload.imageUrls) ? [...originalPayload.imageUrls] : [],
    productPayload: { ...originalPayload, specs: { ...(originalPayload.specs || {}) } },
  };

  return {
    ...item,
    productName: draft.productName.trim(),
    supplierSnapshot,
    productPayload: {
      ...originalPayload,
      imageUrl: normalizedImages[0],
      imageUrls: normalizedImages,
      name: draft.productName.trim(),
      price: sellingPrice,
      originalPrice: normalizedComparePrice,
      discount,
      stock: draft.stock,
      category: draft.category.trim(),
      specs: {
        ...(originalPayload.specs || {}),
        brand,
      },
      isActive: draft.isActive,
      active: draft.isActive,
      visible: draft.isActive,
      approved: true,
      published: true,
    },
  };
}
