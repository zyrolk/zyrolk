import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSupplierApprovalItem,
  calculateSupplierProfit,
  createSupplierReviewDraft,
  validateSupplierPublishPayload,
  validateSupplierReviewDraft,
} from '../src/services/supplierReviewEditor';

const queueItem = {
  id: 'a2z-watch-1',
  productName: 'Supplier Watch',
  supplierCode: 'A2Z-100',
  supplierName: 'A2Z',
  costPrice: 1000,
  marketPrice: 1500,
  stock: 5,
  imageUrl: 'https://a2zdropshipping.lk/products/watch.jpg',
  sourceId: 'a2z',
  batchId: 'batch-1',
  productPayload: {
    id: 'supplier-watch',
    name: 'Supplier Watch',
    description: 'Supplier description',
    price: 1500,
    originalPrice: 1700,
    discount: 12,
    imageUrl: 'https://a2zdropshipping.lk/products/watch.jpg',
    imageUrls: ['https://a2zdropshipping.lk/products/watch.jpg'],
    category: 'electronics',
    rating: 5,
    reviewsCount: 0,
    stock: 5,
    specs: { Brand: 'Supplier Brand' },
    isActive: true,
    costPrice: 1000,
    marketPrice: 1500,
    sku: 'A2Z-100',
    supplierItemCode: 'A2Z-100',
  },
};

test('supplier review draft projects editable product values with safe defaults', () => {
  assert.deepEqual(createSupplierReviewDraft(queueItem), {
    productSku: '',
    supplierItemCode: 'A2Z-100',
    productName: 'Supplier Watch',
    shortDescription: '',
    description: 'Supplier description',
    model: '',
    barcode: '',
    productType: '',
    tags: [],
    keyFeatures: [],
    whatsIncluded: [],
    slug: '',
    metaDescription: '',
    keywords: [],
    sellingPrice: 1500,
    comparePrice: 1700,
    costPrice: 1000,
    marketPrice: 1500,
    stock: 5,
    category: 'electronics',
    subcategory: '',
    brand: 'Supplier Brand',
    specifications: { Brand: 'Supplier Brand' },
    isActive: true,
    isNew: false,
    isFeatured: false,
    isBestSeller: false,
    primaryImageUrl: 'https://a2zdropshipping.lk/products/watch.jpg',
    galleryImageUrls: [],
    fieldOwnership: {
      name: 'admin', shortDescription: 'admin', description: 'admin', model: 'admin', barcode: 'admin',
      productType: 'admin', tags: 'admin', keyFeatures: 'admin', whatsIncluded: 'admin', slug: 'admin',
      metaDescription: 'admin', keywords: 'admin',
      price: 'admin', originalPrice: 'admin', costPrice: 'admin', marketPrice: 'admin', stock: 'admin', category: 'admin', subcategory: 'admin',
      brand: 'admin', specs: 'admin', isActive: 'admin', isNew: 'admin', isFeatured: 'admin',
      isBestSeller: 'admin', imageUrl: 'admin', imageUrls: 'admin',
    },
    editedFields: [],
    supplierCostAvailable: true,
    supplierStockAvailable: true,
  });
});

test('supplier profit and margin update from selling price', () => {
  assert.deepEqual(calculateSupplierProfit(2000, 1250), {
    profit: 750,
    marginPercent: 37.5,
    available: true,
  });
  assert.deepEqual(calculateSupplierProfit(0, 1250), {
    profit: -1250,
    marginPercent: 0,
    available: true,
  });
  assert.deepEqual(calculateSupplierProfit(1000, 0, false), {
    profit: null,
    marginPercent: null,
    available: false,
  });
});

test('supplier review validation blocks invalid publish values', () => {
  const errors = validateSupplierReviewDraft({
    ...createSupplierReviewDraft(queueItem),
    productName: ' ',
    sellingPrice: 0,
    comparePrice: -1,
    stock: 1.5,
    category: '',
    brand: '',
    isActive: true,
    primaryImageUrl: '',
    galleryImageUrls: ['javascript:alert(1)'],
  });

  assert.deepEqual(Object.keys(errors).sort(), ['category', 'comparePrice', 'galleryImageUrls', 'primaryImageUrl', 'productName', 'sellingPrice', 'stock']);
});

test('supplier review validation only accepts configured Zyro categories', () => {
  const draft = createSupplierReviewDraft(queueItem);
  assert.deepEqual(validateSupplierReviewDraft(draft, ['electronics']), {});
  assert.equal(validateSupplierReviewDraft({ ...draft, category: 'unknown' }, ['electronics']).category, 'Select a valid Zyro category.');
});

test('publish payload guard requires image, selling price, and a valid category', () => {
  const invalidItem = structuredClone(queueItem);
  invalidItem.productPayload.imageUrl = '';
  invalidItem.productPayload.imageUrls = [];
  invalidItem.productPayload.price = 0;
  invalidItem.productPayload.category = 'unknown';

  assert.deepEqual(validateSupplierPublishPayload(invalidItem, ['electronics']), {
    imageUrl: 'A valid supplier product image is required before publishing.',
    sellingPrice: 'Selling price must be greater than zero.',
    category: 'Select a valid Zyro category.',
  });
});

test('approval publishes edited values and preserves immutable supplier values for audit', () => {
  const original = structuredClone(queueItem);
  const approved = buildSupplierApprovalItem(queueItem, {
    ...createSupplierReviewDraft(queueItem),
    productName: 'Zyro Smart Watch',
    sellingPrice: 2200,
    comparePrice: 2500,
    costPrice: 1100,
    marketPrice: 2600,
    stock: 8,
    category: 'wearables',
    brand: 'Zyro Select',
    isActive: false,
    primaryImageUrl: 'https://cdn.zyro.lk/watch-primary.webp',
    galleryImageUrls: [
      'https://cdn.zyro.lk/watch-side.webp',
      'https://cdn.zyro.lk/watch-primary.webp',
      'https://cdn.zyro.lk/watch-side.webp',
    ],
  });

  assert.deepEqual(queueItem, original);
  assert.equal(approved.productPayload?.name, 'Zyro Smart Watch');
  assert.equal(approved.productPayload?.price, 2200);
  assert.equal(approved.productPayload?.originalPrice, 2500);
  assert.equal(approved.productPayload?.costPrice, 1100);
  assert.equal(approved.productPayload?.marketPrice, 2600);
  assert.equal(approved.productPayload?.discount, 12);
  assert.equal(approved.productPayload?.stock, 8);
  assert.equal(approved.productPayload?.category, 'wearables');
  assert.equal(approved.productPayload?.specs.brand, 'Zyro Select');
  assert.equal(approved.productPayload?.isActive, false);
  assert.equal(approved.productPayload?.visible, false);
  assert.equal(approved.productPayload?.imageUrl, 'https://cdn.zyro.lk/watch-primary.webp');
  assert.deepEqual(approved.productPayload?.imageUrls, [
    'https://cdn.zyro.lk/watch-primary.webp',
    'https://cdn.zyro.lk/watch-side.webp',
  ]);
  assert.equal(approved.supplierSnapshot?.supplierSku, 'A2Z-100');
  assert.equal(approved.supplierSnapshot?.wholesalePrice, 1000);
  assert.equal((approved.supplierSnapshot?.productPayload as { price: number }).price, 1500);
});

test('approval rejects missing or fake supplier images', () => {
  const invalidItem = structuredClone(queueItem);
  invalidItem.productPayload.imageUrl = 'https://images.unsplash.com/photo-fake';
  invalidItem.productPayload.imageUrls = ['javascript:alert(1)'];

  assert.throws(() => buildSupplierApprovalItem(invalidItem, createSupplierReviewDraft(invalidItem)), /valid supplier product image/i);
});

test('approval rejects an invalid primary image even when the gallery is valid', () => {
  const mixedItem = structuredClone(queueItem);
  mixedItem.productPayload.imageUrl = 'https://images.unsplash.com/photo-fake';
  mixedItem.productPayload.imageUrls = [
    'https://a2zdropshipping.lk/uploads/watch.webp',
    'javascript:alert(1)',
    'https://a2zdropshipping.lk/uploads/watch.webp',
  ];

  assert.throws(() => buildSupplierApprovalItem(mixedItem, createSupplierReviewDraft(mixedItem)), /valid supplier product image/i);
});

test('review draft removes duplicate gallery URLs and keeps the primary separate', () => {
  const duplicateItem = structuredClone(queueItem);
  duplicateItem.productPayload.imageUrls = [
    duplicateItem.productPayload.imageUrl,
    'https://a2zdropshipping.lk/uploads/watch-side.webp',
    'https://a2zdropshipping.lk/uploads/watch-side.webp',
  ];

  const draft = createSupplierReviewDraft(duplicateItem);
  assert.equal(draft.primaryImageUrl, duplicateItem.productPayload.imageUrl);
  assert.deepEqual(draft.galleryImageUrls, ['https://a2zdropshipping.lk/uploads/watch-side.webp']);
});
