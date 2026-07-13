import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSupplierApprovalItem,
  calculateSupplierProfit,
  createSupplierReviewDraft,
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
    productName: 'Supplier Watch',
    sellingPrice: 1500,
    comparePrice: 1700,
    stock: 5,
    category: 'electronics',
    brand: 'Supplier Brand',
    isActive: true,
  });
});

test('supplier profit and margin update from selling price', () => {
  assert.deepEqual(calculateSupplierProfit(2000, 1250), {
    profit: 750,
    marginPercent: 37.5,
  });
  assert.deepEqual(calculateSupplierProfit(0, 1250), {
    profit: -1250,
    marginPercent: 0,
  });
});

test('supplier review validation blocks invalid publish values', () => {
  const errors = validateSupplierReviewDraft({
    productName: ' ',
    sellingPrice: 0,
    comparePrice: -1,
    stock: 1.5,
    category: '',
    brand: '',
    isActive: true,
  });

  assert.deepEqual(Object.keys(errors).sort(), ['category', 'comparePrice', 'productName', 'sellingPrice', 'stock']);
});

test('approval publishes edited values and preserves immutable supplier values for audit', () => {
  const original = structuredClone(queueItem);
  const approved = buildSupplierApprovalItem(queueItem, {
    productName: 'Zyro Smart Watch',
    sellingPrice: 2200,
    comparePrice: 2500,
    stock: 8,
    category: 'wearables',
    brand: 'Zyro Select',
    isActive: false,
  });

  assert.deepEqual(queueItem, original);
  assert.equal(approved.productPayload?.name, 'Zyro Smart Watch');
  assert.equal(approved.productPayload?.price, 2200);
  assert.equal(approved.productPayload?.originalPrice, 2500);
  assert.equal(approved.productPayload?.discount, 12);
  assert.equal(approved.productPayload?.stock, 8);
  assert.equal(approved.productPayload?.category, 'wearables');
  assert.equal(approved.productPayload?.specs.brand, 'Zyro Select');
  assert.equal(approved.productPayload?.isActive, false);
  assert.equal(approved.productPayload?.visible, false);
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

test('approval promotes a valid gallery image and removes invalid entries', () => {
  const mixedItem = structuredClone(queueItem);
  mixedItem.productPayload.imageUrl = 'https://images.unsplash.com/photo-fake';
  mixedItem.productPayload.imageUrls = [
    'https://a2zdropshipping.lk/uploads/watch.webp',
    'javascript:alert(1)',
    'https://a2zdropshipping.lk/uploads/watch.webp',
  ];

  const approved = buildSupplierApprovalItem(mixedItem, createSupplierReviewDraft(mixedItem));
  assert.equal(approved.productPayload?.imageUrl, 'https://a2zdropshipping.lk/uploads/watch.webp');
  assert.deepEqual(approved.productPayload?.imageUrls, ['https://a2zdropshipping.lk/uploads/watch.webp']);
});
