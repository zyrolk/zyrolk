import { Product } from '../types';
import { isValidSupplierImageUrl, normalizeSupplierProductImages } from './connectors/a2z-website/productImages';

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
  managedMedia?: Array<Record<string, unknown>>;
  mediaFailures?: Array<{ originalSupplierUrl?: string; reason?: string; retryable?: boolean; failedAt?: string }>;
  mediaStatus?: string;
  categoryMapping?: {
    supplierCategory?: string;
    targetCategoryId?: string;
    targetSubcategoryId?: string;
    confidence?: number;
    mappingType?: string;
    autoSelected?: boolean;
    requiresManualSelection?: boolean;
  };
  brandMapping?: {
    supplierBrand?: string;
    mappedBrandId?: string;
    confidence?: number;
    mappingType?: string;
    autoSelected?: boolean;
    requiresManualSelection?: boolean;
  };
  productValidation?: {
    readyToPublish?: boolean;
    missingFields?: string[];
    errors?: Array<{ field: string; code: string; message: string }>;
    warnings?: Array<{ field: string; code: string; message: string; severity?: string }>;
  };
}

export interface SupplierReviewMetadataField {
  label: string;
  value: unknown;
}

export interface SupplierReviewMetadataSection {
  id: string;
  title: string;
  fields: SupplierReviewMetadataField[];
  open?: boolean;
}

export interface SupplierReviewDraft {
  productName: string;
  sellingPrice: number;
  comparePrice: number;
  stock: number;
  category: string;
  subcategory?: string;
  brand: string;
  specifications?: Record<string, string>;
  isActive: boolean;
  primaryImageUrl: string;
  galleryImageUrls: string[];
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
  subcategory?: string;
  brand?: string;
  specifications?: string;
  primaryImageUrl?: string;
  galleryImageUrls?: string;
}

export interface SupplierPublishValidationErrors {
  imageUrl?: string;
  imageUrls?: string;
  sellingPrice?: string;
  category?: string;
}

const finiteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const displayValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
};

const recordValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const isHttpsSupplierImageUrl = (value: unknown): value is string => {
  if (!isValidSupplierImageUrl(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

export function buildSupplierReviewMetadataSections(item: SupplierReviewSourceItem): SupplierReviewMetadataSection[] {
  const snapshot: Record<string, unknown> = item.supplierSnapshot || {};
  const payload: Record<string, unknown> = item.productPayload || {};
  const supplierMetadata = {
    ...recordValue(payload.supplierMetadata),
    ...recordValue(snapshot.supplierMetadata),
    ...snapshot,
  };
  const field = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (displayValue(supplierMetadata[key])) return supplierMetadata[key];
      if (displayValue(payload[key])) return payload[key];
    }
    return undefined;
  };
  const section = (id: string, title: string, entries: Array<[string, unknown]>, open = false): SupplierReviewMetadataSection => ({
    id,
    title,
    open,
    fields: entries.filter(([, value]) => displayValue(value)).map(([label, value]) => ({ label, value })),
  });
  const images = field('mediaGallery', 'imageUrls');
  const imageCount = Array.isArray(images) ? images.length : displayValue(field('imageUrl')) ? 1 : 0;
  const extraAttributes = recordValue(field('extraAttributes'));
  const managedMedia = item.managedMedia || (Array.isArray(payload.supplierMedia) ? payload.supplierMedia as Array<Record<string, unknown>> : []);
  const mediaFailures = item.mediaFailures || [];

  return [
    section('basic', 'Basic Information', [
      ['Supplier Product ID', field('supplierProductId')], ['SKU', field('supplierSku', 'sku', 'supplierCode')],
      ['Barcode', field('barcode')], ['Product Name', field('productName', 'title', 'name')],
      ['Short Description', field('shortDescription')], ['Full Description', field('description', 'longDescription')],
      ['Manufacturer', field('manufacturer')], ['Model', field('model')], ['Product Type', field('productType')],
      ['Collection', field('collection')], ['Tags', field('tags')], ['Keywords', field('keywords')],
    ], true),
    section('pricing', 'Pricing', [
      ['Price', field('price')], ['Compare Price', field('comparePrice', 'recommendedRetailPrice', 'marketPrice')],
      ['Cost Price', field('costPrice', 'wholesalePrice')], ['Currency', field('currency')],
      ['Tax', field('tax')], ['Discount', field('discount')],
    ], true),
    section('inventory', 'Inventory', [
      ['Stock', field('inventoryLevel', 'stock')], ['Availability', field('availability')],
      ['Lead Time', field('leadTime')], ['Minimum Order Quantity', field('minimumOrderQuantity')],
      ['Maximum Order Quantity', field('maximumOrderQuantity')], ['Status', field('status')],
      ['Visibility', field('visibility')],
    ]),
    section('media', 'Media', [
      ['Primary Image', field('imageUrl') || (Array.isArray(images) ? images[0] : undefined)],
      ['Gallery Images', images], ['Image Count', imageCount], ['Video URLs', field('videoUrls')],
    ]),
    section('managed-media', 'Managed Media', [
      ['Pipeline Status', item.mediaStatus], ['Managed Asset Count', managedMedia.length],
      ['Assets', managedMedia], ['Download Failures', mediaFailures],
    ]),
    section('category', 'Category', [
      ['Supplier Category', field('supplierCategory') || (Array.isArray(field('categoryHierarchy')) ? (field('categoryHierarchy') as unknown[])[0] : undefined)],
      ['Supplier Subcategory', field('supplierSubcategory') || (Array.isArray(field('categoryHierarchy')) ? (field('categoryHierarchy') as unknown[])[1] : undefined)],
      ['Category Hierarchy', field('categoryHierarchy')], ['Mapped Category', payload.category], ['Mapped Subcategory', payload.subcategory],
    ]),
    section('brand', 'Brand', [
      ['Supplier Brand', field('brand')], ['Mapped Brand', payload.brand], ['Manufacturer', field('manufacturer')],
    ]),
    section('specifications', 'Specifications', [
      ['Specifications', field('specifications', 'specs')], ['Features', field('features')], ['Attributes', field('attributes')],
    ]),
    section('variants', 'Variants & Options', [
      ['Variants', field('variants')], ['Options', field('options')],
    ]),
    section('shipping', 'Shipping', [
      ['Dimensions', field('dimensions')], ['Weight', field('weight')], ['Package Size', field('packageSize')],
      ['Shipping Class', field('shippingClass')], ['Country of Origin', field('countryOfOrigin')], ['Warranty', field('warranty')],
    ]),
    section('seo', 'SEO', [
      ['Slug', field('slug')], ['Meta Description', field('metaDescription')], ['Keywords', field('keywords')],
    ]),
    section('supplier-metadata', 'Supplier Metadata', [
      ['Supplier', item.supplierName], ['Supplier ID', field('supplierId')], ['Source ID', item.sourceId || field('sourceId')],
      ['Supplier Priority', field('supplierPriority')], ['Batch ID', item.batchId], ['Created Date', field('createdDate')],
      ['Last Updated', field('lastUpdated')], ['Provided Fields', field('providedFields')],
    ]),
    section('extra-attributes', 'Extra Attributes', Object.entries(extraAttributes)),
  ];
}

export function createSupplierReviewDraft(item: SupplierReviewSourceItem): SupplierReviewDraft {
  const payload = item.productPayload;
  const specs = payload?.specs || {};
  const primaryImageUrl = String(payload?.imageUrl || item.imageUrl || '').trim();
  const galleryImageUrls = [...new Set(
    (Array.isArray(payload?.imageUrls) ? payload.imageUrls : [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => Boolean(value) && value !== primaryImageUrl),
  )];

  return {
    productName: String(payload?.name || item.productName || ''),
    sellingPrice: finiteNumber(payload?.price, finiteNumber(item.marketPrice)),
    comparePrice: finiteNumber(payload?.originalPrice, finiteNumber(item.marketPrice)),
    stock: Math.max(0, Math.floor(finiteNumber(payload?.stock, finiteNumber(item.stock)))),
    category: String(payload?.category || (item.categoryMapping?.autoSelected ? item.categoryMapping.targetCategoryId : '') || ''),
    subcategory: String(payload?.subcategory || (item.categoryMapping?.autoSelected ? item.categoryMapping.targetSubcategoryId : '') || ''),
    brand: String(payload?.brand || (item.brandMapping?.autoSelected ? item.brandMapping.mappedBrandId : '') || specs.brand || specs.Brand || ''),
    specifications: Object.fromEntries(Object.entries(specs).map(([key, value]) => [key, String(value || '')])),
    isActive: payload?.isActive !== false,
    primaryImageUrl,
    galleryImageUrls,
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

export function validateSupplierReviewDraft(
  draft: SupplierReviewDraft,
  validCategoryIds?: readonly string[],
  categories?: ReadonlyArray<{
    id: string;
    isActive?: boolean;
    subcategories?: Array<{ id: string; isActive?: boolean }>;
    specificationTemplate?: Array<{ name: string; required?: boolean }>;
  }>,
  brands?: ReadonlyArray<{ id: string; isActive?: boolean }>,
): SupplierReviewValidationErrors {
  const errors: SupplierReviewValidationErrors = {};

  if (!draft.productName.trim()) errors.productName = 'Product name is required.';
  if (!Number.isFinite(draft.sellingPrice) || draft.sellingPrice <= 0) errors.sellingPrice = 'Selling price must be greater than zero.';
  if (!Number.isFinite(draft.comparePrice) || draft.comparePrice < 0) errors.comparePrice = 'Compare price cannot be negative.';
  if (draft.comparePrice > 0 && draft.comparePrice < draft.sellingPrice) errors.comparePrice = 'Compare price must be at least the selling price.';
  if (!Number.isInteger(draft.stock) || draft.stock < 0) errors.stock = 'Stock must be a whole number of zero or more.';
  if (!isHttpsSupplierImageUrl(draft.primaryImageUrl)) {
    errors.primaryImageUrl = 'A valid supplier product image using HTTPS is required before publishing.';
  }
  if (draft.galleryImageUrls.length > 19) {
    errors.galleryImageUrls = 'A product can contain at most 20 managed images.';
  } else if (draft.galleryImageUrls.some((url) => !isHttpsSupplierImageUrl(url))) {
    errors.galleryImageUrls = 'Remove or replace invalid non-HTTPS gallery image URLs.';
  }
  const category = draft.category.trim();
  if (!category) {
    errors.category = 'Category is required.';
  } else if (validCategoryIds && !validCategoryIds.includes(category)) {
    errors.category = 'Select a valid Zyro category.';
  }
  const selectedCategory = categories?.find((candidate) => candidate.id === category);
  if (selectedCategory?.isActive === false) errors.category = 'Select an active Zyro category.';
  const activeSubcategories = (selectedCategory?.subcategories || []).filter((subcategory) => subcategory.isActive !== false);
  if (activeSubcategories.length > 0 && !activeSubcategories.some((subcategory) => subcategory.id === String(draft.subcategory || '').trim())) {
    errors.subcategory = 'Select an active subcategory belonging to the category.';
  }
  if (brands && !brands.some((brand) => brand.id === draft.brand.trim() && brand.isActive !== false)) {
    errors.brand = 'Select an active registered brand.';
  }
  const normalizedSpecifications = new Map(Object.entries(draft.specifications || {})
    .map(([key, value]) => [key.normalize('NFKC').trim().toLocaleLowerCase(), value.trim()]));
  const missingSpecifications = (selectedCategory?.specificationTemplate || [])
    .filter((field) => field.required && !normalizedSpecifications.get(field.name.normalize('NFKC').trim().toLocaleLowerCase()))
    .map((field) => field.name);
  if (missingSpecifications.length > 0) {
    errors.specifications = `Complete required specifications: ${missingSpecifications.join(', ')}.`;
  }

  return errors;
}

export function validateSupplierPublishPayload(
  item: Pick<SupplierReviewSourceItem, 'productPayload'>,
  validCategoryIds?: readonly string[],
): SupplierPublishValidationErrors {
  const payload = item.productPayload;
  const errors: SupplierPublishValidationErrors = {};
  const primaryImageIsValid = isValidSupplierImageUrl(payload?.imageUrl);
  const sellingPrice = finiteNumber(payload?.price, Number.NaN);
  const category = String(payload?.category || '').trim();

  if (!primaryImageIsValid) {
    errors.imageUrl = 'A valid supplier product image is required before publishing.';
  }
  if ((Array.isArray(payload?.imageUrls) ? payload.imageUrls : []).some((url) => !isValidSupplierImageUrl(url))) {
    errors.imageUrls = 'Every gallery image must use a valid supplier image URL.';
  }
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) {
    errors.sellingPrice = 'Selling price must be greater than zero.';
  }
  if (!category) {
    errors.category = 'Category is required.';
  } else if (validCategoryIds && !validCategoryIds.includes(category)) {
    errors.category = 'Select a valid Zyro category.';
  }

  return errors;
}

export function buildSupplierApprovalItem(
  item: SupplierReviewSourceItem,
  draft: SupplierReviewDraft,
  validCategoryIds?: readonly string[],
): SupplierReviewSourceItem {
  const validationErrors = validateSupplierReviewDraft(draft, validCategoryIds);
  if (Object.keys(validationErrors).length > 0) {
    throw new Error(Object.values(validationErrors)[0]);
  }

  if (!item.productPayload?.id) {
    throw new Error(`Product payload not found for queue item: ${item.id}`);
  }

  const originalPayload = item.productPayload;
  const normalizedImages = normalizeSupplierProductImages(draft.primaryImageUrl, draft.galleryImageUrls);
  const primaryImageUrl = draft.primaryImageUrl.trim();
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
      imageUrl: primaryImageUrl,
      imageUrls: normalizedImages,
      name: draft.productName.trim(),
      price: sellingPrice,
      originalPrice: normalizedComparePrice,
      discount,
      stock: draft.stock,
      category: draft.category.trim(),
      subcategory: String(draft.subcategory || '').trim(),
      brand,
      specs: {
        ...(originalPayload.specs || {}),
        ...(draft.specifications || {}),
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
