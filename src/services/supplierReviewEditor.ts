import { Product } from '../types';
import { isValidSupplierImageUrl, normalizeSupplierProductImages } from './connectors/a2z-website/productImages';
import { parseSupplierProductFieldOwnership, SupplierProductFieldOwner } from './products/supplierFieldOwnership';
import { hasExplicitSupplierCommerceMetadata, readSupplierCommerceAvailability } from './supplierCommerceSemantics';

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
  matchedProductId?: string | null;
  supplierOfferId?: string;
  approvalConflict?: {
    reason?: string;
    changedFields?: string[];
    previousVersion?: string;
    currentVersion?: string;
  };
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
  comparison?: {
    comparisonStatus?: string;
    fieldChanges?: SupplierReviewFieldChange[];
  };
}

export interface SupplierReviewFieldChange {
  field: string;
  label: string;
  auditKey?: string;
  auditRepresentation?: string;
  before: unknown;
  after: unknown;
  changeType?: 'added' | 'changed' | 'invalid_removal';
  syncGroup?: string;
  emptyBehavior?: string;
  adminEditable?: boolean;
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
  productSku: string;
  supplierItemCode: string;
  productName: string;
  shortDescription: string;
  description: string;
  model: string;
  barcode: string;
  productType: string;
  tags: string[];
  keyFeatures: string[];
  whatsIncluded: string[];
  slug: string;
  metaDescription: string;
  keywords: string[];
  sellingPrice: number;
  comparePrice: number;
  costPrice: number;
  marketPrice: number;
  stock: number;
  category: string;
  subcategory?: string;
  brand: string;
  specifications?: Record<string, string>;
  isActive: boolean;
  isNew: boolean;
  isFeatured: boolean;
  isBestSeller: boolean;
  primaryImageUrl: string;
  galleryImageUrls: string[];
  fieldOwnership: Record<string, SupplierProductFieldOwner>;
  editedFields: string[];
  supplierCostAvailable: boolean;
  supplierStockAvailable: boolean;
}

export const SUPPLIER_REVIEW_EDITABLE_FIELDS = [
  'name', 'shortDescription', 'description', 'model', 'barcode', 'productType', 'tags', 'keyFeatures',
  'whatsIncluded', 'slug', 'metaDescription', 'keywords', 'price', 'originalPrice', 'costPrice', 'marketPrice', 'stock', 'category', 'subcategory', 'brand', 'specs',
  'isActive', 'isNew', 'isFeatured', 'isBestSeller', 'imageUrl', 'imageUrls',
] as const;

export type SupplierReviewEditableField = typeof SUPPLIER_REVIEW_EDITABLE_FIELDS[number];

const ADMIN_ONLY_REVIEW_FIELDS = new Set<SupplierReviewEditableField>(['keyFeatures', 'whatsIncluded', 'isNew', 'isFeatured', 'isBestSeller']);

export interface SupplierProfitMetrics {
  profit: number | null;
  marginPercent: number | null;
  available: boolean;
}

export interface SupplierReviewValidationErrors {
  productName?: string;
  shortDescription?: string;
  description?: string;
  model?: string;
  barcode?: string;
  productType?: string;
  slug?: string;
  metaDescription?: string;
  keywords?: string;
  sellingPrice?: string;
  comparePrice?: string;
  costPrice?: string;
  marketPrice?: string;
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

const textList = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))]
  : [];

const isHttpsSupplierImageUrl = (value: unknown): value is string => {
  if (!isValidSupplierImageUrl(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

export function buildSupplierReviewFieldChanges(item: SupplierReviewSourceItem): SupplierReviewFieldChange[] {
  const changes = item.comparison?.fieldChanges;
  if (!Array.isArray(changes)) return [];
  return changes.filter((change) => (
    change
    && typeof change === 'object'
    && typeof change.field === 'string'
    && typeof change.label === 'string'
  ));
}

const SUPPLIER_FIELD_PRODUCT_PATHS: Record<string, readonly string[]> = {
  title: ['name'],
  longDescription: ['description'],
  shortDescription: ['shortDescription'],
  price: ['price', 'originalPrice'],
  comparePrice: ['originalPrice'],
  costPrice: ['costPrice'],
  marketPrice: ['marketPrice'],
  stock: ['stock'],
  mediaGallery: ['imageUrl', 'imageUrls'],
  productType: ['productType'],
  model: ['model'],
  tags: ['tags'],
  keywords: ['keywords'],
  slug: ['slug'],
  metaDescription: ['metaDescription'],
  specifications: ['specs'],
  brand: ['brand'],
  categoryHierarchy: ['category', 'subcategory'],
  supplierCategory: ['category'],
  supplierSubcategory: ['subcategory'],
};

const SUPPLIER_REVIEW_EDITABLE_PRODUCT_FIELDS = new Set([
  'name', 'description', 'shortDescription', 'price', 'originalPrice', 'costPrice', 'marketPrice',
  'stock', 'imageUrl', 'imageUrls', 'productType', 'model', 'tags', 'keywords', 'slug',
  'metaDescription', 'specs', 'brand', 'category', 'subcategory',
]);

const resolveSupplierReviewEditedFields = (item: SupplierReviewSourceItem): string[] => {
  if (item.comparison?.comparisonStatus === 'NEW_PRODUCT') return [];
  const fields = new Set<string>();
  for (const change of buildSupplierReviewFieldChanges(item)) {
    for (const path of SUPPLIER_FIELD_PRODUCT_PATHS[change.field] || []) {
      if (SUPPLIER_REVIEW_EDITABLE_PRODUCT_FIELDS.has(path)) fields.add(path);
    }
  }
  return [...fields];
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
    ], false),
    section('pricing', 'Pricing', [
      ['Price', field('price')], ['Compare Price', field('comparePrice', 'recommendedRetailPrice', 'marketPrice')],
      ['Cost Price', field('costPrice', 'wholesalePrice')], ['Currency', field('currency')],
      ['Tax', field('tax')], ['Discount', field('discount')],
    ], false),
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

const optionalFiniteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function createSupplierReviewDraft(item: SupplierReviewSourceItem): SupplierReviewDraft {
  const payload = item.productPayload;
  const snapshot = item.supplierSnapshot || {};
  const metadata = (payload?.supplierMetadata && typeof payload.supplierMetadata === 'object'
    ? payload.supplierMetadata
    : snapshot) as Record<string, unknown>;
  const editedFields = resolveSupplierReviewEditedFields(item);
  const costEditedByAdmin = editedFields.includes('costPrice');
  const stockEditedByAdmin = editedFields.includes('stock');
  const resolvedCost = optionalFiniteNumber(payload?.costPrice ?? item.costPrice ?? snapshot.wholesalePrice);
  const resolvedStock = optionalFiniteNumber(payload?.stock ?? item.stock ?? snapshot.stock);
  const metadataRecord = metadata as Record<string, unknown>;
  const availability = readSupplierCommerceAvailability({
    supplierMetadata: metadata,
    supplierSnapshot: snapshot,
    providedFields: Array.isArray(metadata.providedFields) ? metadata.providedFields as string[] : undefined,
  });
  let supplierCostAvailable = availability.supplierCostAvailable || costEditedByAdmin;
  let supplierStockAvailable = availability.supplierStockAvailable || stockEditedByAdmin;
  if (!hasExplicitSupplierCommerceMetadata(
    metadataRecord,
    Array.isArray(metadata.providedFields) ? metadata.providedFields as string[] : undefined,
  )) {
    if (!costEditedByAdmin && Number.isFinite(resolvedCost)) supplierCostAvailable = true;
    if (!stockEditedByAdmin && Number.isFinite(resolvedStock)) supplierStockAvailable = true;
  }
  const specs = payload?.specs || {};
  const primaryImageUrl = String(payload?.imageUrl || item.imageUrl || '').trim();
  const galleryImageUrls = [...new Set(
    (Array.isArray(payload?.imageUrls) ? payload.imageUrls : [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => Boolean(value) && value !== primaryImageUrl),
  )];
  const storedOwnership = parseSupplierProductFieldOwnership(payload?.supplierFieldOwnership);
  const isNewProduct = item.comparison?.comparisonStatus === 'NEW_PRODUCT';
  const fieldOwnership = Object.fromEntries(SUPPLIER_REVIEW_EDITABLE_FIELDS.map((field) => [
    field,
    storedOwnership[field]?.owner || (isNewProduct && !ADMIN_ONLY_REVIEW_FIELDS.has(field) ? 'supplier' : 'admin'),
  ])) as Record<string, SupplierProductFieldOwner>;

  return {
    productSku: /^ZY-/iu.test(String(payload?.sku || '').trim()) ? String(payload?.sku).trim() : '',
    supplierItemCode: String(payload?.supplierItemCode || item.supplierCode || '').trim(),
    productName: String(payload?.name || item.productName || ''),
    shortDescription: String(payload?.shortDescription || ''),
    description: String(payload?.description || payload?.longDescription || ''),
    model: String(payload?.model || ''),
    barcode: String(payload?.barcode || ''),
    productType: String(payload?.productType || ''),
    tags: textList(payload?.tags),
    keyFeatures: textList(payload?.keyFeatures || payload?.features),
    whatsIncluded: textList(payload?.whatsIncluded),
    slug: String(payload?.slug || ''),
    metaDescription: String(payload?.metaDescription || ''),
    keywords: textList(payload?.keywords),
    sellingPrice: finiteNumber(payload?.price, finiteNumber(item.marketPrice)),
    comparePrice: finiteNumber(payload?.originalPrice, finiteNumber(item.marketPrice)),
    costPrice: supplierCostAvailable ? finiteNumber(resolvedCost, 0) : finiteNumber(resolvedCost, Number.NaN),
    marketPrice: finiteNumber(payload?.marketPrice, finiteNumber(item.marketPrice)),
    stock: supplierStockAvailable
      ? Math.max(0, Math.floor(finiteNumber(resolvedStock, 0)))
      : Math.max(0, Math.floor(finiteNumber(resolvedStock, Number.NaN))),
    category: String(payload?.category || (item.categoryMapping?.autoSelected ? item.categoryMapping.targetCategoryId : '') || ''),
    subcategory: String(payload?.subcategory || (item.categoryMapping?.autoSelected ? item.categoryMapping.targetSubcategoryId : '') || ''),
    brand: String(payload?.brand || (item.brandMapping?.autoSelected ? item.brandMapping.mappedBrandId : '') || specs.brand || specs.Brand || ''),
    specifications: Object.fromEntries(Object.entries(specs).map(([key, value]) => [key, String(value || '')])),
    isActive: payload?.isActive !== false,
    isNew: payload?.isNew === true,
    isFeatured: payload?.isFeatured === true,
    isBestSeller: payload?.isBestSeller === true,
    primaryImageUrl,
    galleryImageUrls,
    fieldOwnership,
    editedFields,
    supplierCostAvailable,
    supplierStockAvailable,
  };
}

export function updateSupplierReviewDraftField(
  draft: SupplierReviewDraft,
  field: SupplierReviewEditableField,
  patch: Partial<SupplierReviewDraft>,
): SupplierReviewDraft {
  const next = {
    ...draft,
    ...patch,
    fieldOwnership: { ...draft.fieldOwnership, [field]: 'admin' },
    editedFields: [...new Set([...draft.editedFields, field])],
  };
  if (field === 'costPrice') {
    next.supplierCostAvailable = true;
  }
  if (field === 'stock') {
    next.supplierStockAvailable = true;
  }
  return next as SupplierReviewDraft;
}

export function setSupplierReviewDraftFieldOwner(
  draft: SupplierReviewDraft,
  field: SupplierReviewEditableField,
  owner: SupplierProductFieldOwner,
): SupplierReviewDraft {
  return { ...draft, fieldOwnership: { ...draft.fieldOwnership, [field]: owner } };
}

export function calculateSupplierProfit(
  sellingPrice: number,
  wholesalePrice: number,
  costAvailable = true,
): SupplierProfitMetrics {
  if (!costAvailable) {
    return { profit: null, marginPercent: null, available: false };
  }
  const selling = finiteNumber(sellingPrice);
  const wholesale = finiteNumber(wholesalePrice);
  const profit = selling - wholesale;

  return {
    profit,
    marginPercent: selling > 0 ? (profit / selling) * 100 : 0,
    available: true,
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
  if (!draft.description.trim()) errors.description = 'Full description is required.';
  if ((draft.shortDescription || '').length > 500) errors.shortDescription = 'Short description must contain 500 characters or fewer.';
  if ((draft.description || '').length > 20_000) errors.description = 'Description must contain 20,000 characters or fewer.';
  if ((draft.model || '').length > 160) errors.model = 'Model must contain 160 characters or fewer.';
  if ((draft.barcode || '').length > 64) errors.barcode = 'Barcode must contain 64 characters or fewer.';
  if ((draft.productType || '').length > 160) errors.productType = 'Product type must contain 160 characters or fewer.';
  if ((draft.slug || '').length > 160) errors.slug = 'SEO slug must contain 160 characters or fewer.';
  if ((draft.metaDescription || '').length > 500) errors.metaDescription = 'Meta description must contain 500 characters or fewer.';
  if (draft.keywords.length > 40 || draft.keywords.some((keyword) => keyword.length > 240)) {
    errors.keywords = 'Use no more than 40 keywords, with 240 characters or fewer per keyword.';
  }
  if (!Number.isFinite(draft.sellingPrice) || draft.sellingPrice <= 0) errors.sellingPrice = 'Selling price must be greater than zero.';
  if (!Number.isFinite(draft.comparePrice) || draft.comparePrice < 0) errors.comparePrice = 'Compare price cannot be negative.';
  if (draft.comparePrice > 0 && draft.comparePrice < draft.sellingPrice) errors.comparePrice = 'Compare price must be at least the selling price.';
  if (!draft.supplierCostAvailable) {
    if (!Number.isFinite(draft.costPrice) || draft.costPrice < 0) {
      errors.costPrice = 'Supplier cost was not provided. Enter a valid supplier cost before approval.';
    }
  } else if (!Number.isFinite(draft.costPrice) || draft.costPrice < 0) {
    errors.costPrice = 'Cost price cannot be negative.';
  }
  if (!Number.isFinite(draft.marketPrice) || draft.marketPrice < 0) errors.marketPrice = 'Market price cannot be negative.';
  if (!draft.supplierStockAvailable) {
    if (!Number.isInteger(draft.stock) || draft.stock < 0) {
      errors.stock = 'Supplier inventory was not provided.';
    }
  } else if (!Number.isInteger(draft.stock) || draft.stock < 0) {
    errors.stock = 'Stock must be a whole number of zero or more.';
  }
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
      shortDescription: String(draft.shortDescription || '').trim(),
      description: String(draft.description || '').trim(),
      model: String(draft.model || '').trim(),
      barcode: String(draft.barcode || '').trim(),
      productType: String(draft.productType || '').trim(),
      tags: textList(draft.tags),
      keyFeatures: textList(draft.keyFeatures),
      whatsIncluded: textList(draft.whatsIncluded),
      slug: String(draft.slug || '').trim(),
      metaDescription: String(draft.metaDescription || '').trim(),
      keywords: textList(draft.keywords),
      price: sellingPrice,
      originalPrice: normalizedComparePrice,
      costPrice: finiteNumber(draft.costPrice),
      marketPrice: finiteNumber(draft.marketPrice),
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
      isNew: draft.isNew,
      isFeatured: draft.isFeatured,
      isBestSeller: draft.isBestSeller,
      active: draft.isActive,
      visible: draft.isActive,
      approved: true,
      published: true,
      ...(draft.fieldOwnership ? { supplierFieldOwnership: draft.fieldOwnership } : {}),
    },
  };
}
