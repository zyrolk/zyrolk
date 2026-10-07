import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSupplierReviewDraft,
} from '../src/services/supplierReviewEditor';
import { supplierReviewDisplayImageUrl } from '../src/services/supplierHubPresentation';
import {
  suggestSupplierCategory,
  validateSupplierProductForApproval,
} from '../functions/src/api/suppliers/supplierProductMapping';
import {
  buildSupplierReviewBusinessQueueProjection,
  reviewRecordMatchesBusinessFilter,
} from '../functions/src/scheduled/supplierReviewQueue';

const categories = [
  {
    id: 'tools',
    name: 'Tools',
    isActive: true,
    keywords: ['hand tools'],
    subcategories: [{ id: 'knives', name: 'Knives', isActive: true }],
    specificationTemplate: [{ name: 'Blade material', required: true }],
  },
  {
    id: 'electronics',
    name: 'Electronics',
    isActive: true,
    subcategories: [],
  },
  {
    id: 'sunglasses',
    name: 'Sunglasses',
    isActive: true,
    subcategories: [],
  },
];

test('trusted supplier taxonomy mapping resolves only to active canonical Zyro taxonomy', () => {
  const suggestion = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Cutlery', 'Pocket Knives'],
    productTitle: 'Foldable Pocket Knife',
    categories,
    mappings: [{
      sourceId: 'dropex',
      supplierCategory: 'Cutlery',
      normalizedCategory: 'cutlery',
      targetCategoryId: 'tools',
      targetSubcategoryId: '',
      confidence: 100,
      mappingType: 'manual',
      mappingScope: 'parent',
      version: 1,
      updatedBy: 'admin',
    }, {
      sourceId: 'dropex',
      supplierCategory: 'Cutlery',
      normalizedCategory: 'cutlery',
      supplierSubcategory: 'Pocket Knives',
      normalizedSupplierSubcategory: 'pocket knives',
      targetCategoryId: 'tools',
      targetSubcategoryId: 'knives',
      confidence: 100,
      mappingType: 'manual',
      mappingScope: 'child',
      version: 1,
      updatedBy: 'admin',
    }],
  });
  assert.deepEqual(
    {
      category: suggestion.targetCategoryId,
      subcategory: suggestion.targetSubcategoryId,
      autoSelected: suggestion.autoSelected,
    },
    { category: 'tools', subcategory: 'knives', autoSelected: true },
  );
});

test('unresolved supplier taxonomy stays attention-required instead of guessing a canonical category', () => {
  const suggestion = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Unmapped Supplier Department'],
    productTitle: 'Foldable Pocket Knife',
    categories,
  });
  assert.equal(suggestion.targetCategoryId, '');
  assert.equal(suggestion.autoSelected, false);
  assert.equal(suggestion.requiresManualSelection, true);
});

test('supplier taxonomy cannot override contradictory product-owned evidence', () => {
  const suggestion = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Vehicle Accessories'],
    productTitle: "Women's Sunglasses",
    description: 'Polarized sunglasses for everyday wear',
    categories,
  });
  assert.equal(suggestion.targetCategoryId, 'sunglasses');
  assert.equal(suggestion.autoSelected, true);
  assert.notEqual(suggestion.targetCategoryId, 'vehicle-accessories');
});

test('server review validation enforces required specifications while optional brand remains optional', () => {
  const base = {
    name: 'Foldable Pocket Knife',
    description: 'A useful folding knife.',
    imageUrl: 'https://supplier.example/image.webp',
    price: 1500,
    costPrice: 900,
    stock: 5,
    isActive: true,
    category: 'tools',
    subcategory: 'knives',
    brand: '',
    specs: {},
    supplierMetadata: { supplierCostAvailable: true, supplierStockAvailable: true },
  };
  const missing = validateSupplierProductForApproval(base, categories, []);
  assert.deepEqual(missing.map((error) => error.field), ['specs.Blade material']);
  const complete = validateSupplierProductForApproval({ ...base, specs: { 'Blade material': 'Stainless steel' } }, categories, []);
  assert.deepEqual(complete, []);
});

test('review drafts and cards do not present raw supplier HTTPS media as publishable media', () => {
  const item = {
    id: 'review-1',
    productName: 'Foldable Pocket Knife',
    supplierCode: 'ASN0047',
    sourceId: 'dropex',
    costPrice: 900,
    marketPrice: 1500,
    stock: 5,
    imageUrl: 'https://supplier.example/image.webp',
    productPayload: {
      name: 'Foldable Pocket Knife',
      description: 'A useful folding knife.',
      imageUrl: 'https://supplier.example/image.webp',
      imageUrls: ['https://supplier.example/image.webp'],
      price: 1500,
      costPrice: 900,
      stock: 5,
      category: '',
      subcategory: '',
      specs: {},
    },
    managedMedia: [],
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
  };
  const draft = createSupplierReviewDraft(item as never);
  assert.equal(draft.primaryImageUrl, '');
  assert.equal(supplierReviewDisplayImageUrl(item as never), '');
});

test('complete trusted supplier proposal is one-click review-ready without a mandatory edit', () => {
  const managedImage = 'https://firebasestorage.googleapis.com/v0/b/demo/o/supplier-media%2Fmanaged.webp?alt=media';
  const record = {
    id: 'review-complete-1',
    status: 'Pending',
    queueState: 'review_pending',
    sourceId: 'dropex',
    comparisonStatus: 'NEW_PRODUCT',
    comparison: { comparisonStatus: 'NEW_PRODUCT', changedFields: [] },
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    mediaStatus: 'ready',
    mediaReadiness: 'publication_safe',
    mediaQueueClass: 'ready',
    mediaSourceImageUrls: ['https://supplier.example/image.webp'],
    managedMedia: [{
      contentHash: 'b'.repeat(64),
      firebaseStorageUrl: managedImage,
      originalSupplierUrl: 'https://supplier.example/image.webp',
      storagePath: 'supplier-review/complete-1/managed.webp',
      imageStatus: 'ready',
      isPrimary: true,
      variants: { large: { firebaseStorageUrl: managedImage } },
    }],
    productPayload: {
      name: 'Electronics Kitchen Device',
      description: 'A complete review proposal.',
      price: 1500,
      costPrice: 900,
      stock: 8,
      category: 'electronics',
      specs: { Model: 'EK-1' },
      imageUrl: managedImage,
      imageUrls: [managedImage],
    },
    stock: 8,
    supplierSnapshot: {
      supplierStockAvailable: true,
      supplierCostAvailable: true,
    },
  };
  const projection = buildSupplierReviewBusinessQueueProjection(record as never, false);
  assert.ok((projection.businessQueueClasses as string[]).includes('ready_for_review'));
  assert.equal(reviewRecordMatchesBusinessFilter(record as never, 'ready_for_review'), true);
  const draft = createSupplierReviewDraft(record as never);
  assert.equal(draft.primaryImageUrl, managedImage);
  assert.equal(draft.productName, 'Electronics Kitchen Device');
  assert.equal(draft.category, 'electronics');
  assert.deepEqual(validateSupplierProductForApproval({
    name: draft.productName,
    description: draft.description,
    imageUrl: draft.primaryImageUrl,
    imageUrls: draft.galleryImageUrls,
    price: draft.sellingPrice,
    costPrice: draft.costPrice,
    stock: draft.stock,
    category: draft.category,
    subcategory: draft.subcategory,
    specs: draft.specifications,
    visible: draft.isActive,
    supplierMetadata: { supplierStockAvailable: true, supplierCostAvailable: true },
  }, categories, []), []);
});
