import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HOMEPAGE_REVIEW_LIMIT,
  mergeStorefrontProducts,
  projectStorefrontProduct,
  STOREFRONT_CATEGORY_LIMIT,
  STOREFRONT_PRODUCT_PAGE_SIZE,
} from '../src/services/storefront/storefrontCatalog';

const source = (path: string): string => readFileSync(path, 'utf8');

test('customer product projection is allowlisted and strips commercial data', () => {
  const product = projectStorefrontProduct('product-1', {
    name: 'Safe Product',
    description: 'Public description',
    price: 2500,
    imageUrl: 'https://cdn.example/product.webp',
    category: 'electronics',
    rating: 4.5,
    reviewsCount: 8,
    stock: 5,
    specs: { Display: 'OLED' },
    costPrice: 1000,
    marketPrice: 3000,
    supplierItemCode: 'PRIVATE-SKU',
    supplierId: 'private-supplier',
  });

  assert.equal(product.id, 'product-1');
  assert.equal(product.rating, 4.5);
  assert.equal(product.reviewsCount, 8);
  assert.deepEqual(product.specs, { Display: 'OLED' });
  assert.equal(product.costPrice, undefined);
  assert.equal(product.marketPrice, undefined);
  assert.equal(product.supplierItemCode, undefined);
  assert.equal(product.supplierId, undefined);
  assert.equal(product.sku, undefined);
});

test('catalog page merging is deterministic and replaces fresher products', () => {
  const original = projectStorefrontProduct('product-1', {
    name: 'Original', price: 100, imageUrl: '', category: 'home', stock: 1,
  });
  const updated = projectStorefrontProduct('product-1', {
    name: 'Updated', price: 120, imageUrl: '', category: 'home', stock: 2,
  });
  const second = projectStorefrontProduct('product-2', {
    name: 'Second', price: 200, imageUrl: '', category: 'home', stock: 3,
  });

  const merged = mergeStorefrontProducts([original], [updated, second]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((product) => product.id === 'product-1')?.name, 'Updated');
});

test('storefront catalog uses bounded indexed cursor queries and targeted personalization reads', () => {
  const catalog = source('src/services/storefront/storefrontCatalog.ts');
  const app = source('src/App.tsx');

  assert.equal(STOREFRONT_PRODUCT_PAGE_SIZE, 24);
  assert.equal(STOREFRONT_CATEGORY_LIMIT, 100);
  assert.equal(HOMEPAGE_REVIEW_LIMIT, 6);
  assert.match(catalog, /orderBy\(documentId\(\)\)[\s\S]*limit\(STOREFRONT_PRODUCT_PAGE_SIZE\)/);
  assert.match(catalog, /startAfter\(cursor\)/);
  assert.match(catalog, /where\(documentId\(\), 'in', chunk\)/);
  assert.match(catalog, /where\('approved', '==', true\)[\s\S]*limit\(HOMEPAGE_REVIEW_LIMIT\)/);
  assert.doesNotMatch(app, /onSnapshot\(collection\(db, ["']products["']\)/);
  assert.match(app, /loadStorefrontProductsByIds\(db, missingIds\)/);
  assert.match(app, /Load more products/);
});

test('all customer collection listeners are explicitly bounded', () => {
  const reviews = source('src/features/reviews/ProductReviewsAndQuestions.tsx');
  const account = source('src/features/account/AccountCenter.tsx');
  const checkout = source('src/features/checkout/PremiumCheckoutDrawer.tsx');

  assert.match(reviews, /limit\(PRODUCT_REVIEW_READ_LIMIT\)/);
  assert.match(reviews, /limit\(PRODUCT_QUESTION_READ_LIMIT\)/);
  assert.match(account, /limit\(CUSTOMER_ORDER_READ_LIMIT\)/);
  assert.match(account, /limit\(CUSTOMER_ADDRESS_READ_LIMIT\)/);
  assert.match(checkout, /limit\(CHECKOUT_ADDRESS_READ_LIMIT\)/);
});

test('admin dashboard uses bounded live pages, aggregation counts, and cursor pagination', () => {
  const admin = source('src/components/AdminDashboard.tsx');

  for (const bound of [
    'ADMIN_ORDER_READ_LIMIT',
    'ADMIN_REVIEW_READ_LIMIT',
    'ADMIN_PRODUCT_PAGE_SIZE',
    'ADMIN_USER_READ_LIMIT',
  ]) {
    assert.match(admin, new RegExp(`limit\\(${bound}\\)`));
  }
  assert.match(admin, /getCountFromServer\(collection\(db, 'orders'\)\)/);
  assert.match(admin, /getAggregateFromServer\([\s\S]*totalSales: sum\('totalPrice'\)/);
  assert.match(admin, /startAfter\(cursor\)/);
  assert.match(admin, /Load more products/);
  assert.doesNotMatch(admin, /onSnapshot\(collection\(db, ["'](?:orders|reviews|products|product_private)["']\)/);
});

test('safe route-level bundle boundaries remain in place', () => {
  const app = source('src/App.tsx');
  const vite = source('vite.config.ts');
  assert.match(app, /const AdminDashboard = lazy/);
  assert.match(app, /const ProductFilters = lazy/);
  assert.doesNotMatch(app, /from ['"]motion\/react['"]/);
  assert.ok(vite.indexOf("id.includes('recharts')") < vite.indexOf("id.includes('react') ||"));
});

test('required Firestore indexes cover customer storefront and supplier investigation queries exactly', () => {
  const indexes = JSON.parse(source('firestore.indexes.json')) as {
    indexes: Array<{
      collectionGroup: string;
      queryScope: string;
      fields: Array<{ fieldPath: string; order: string }>;
    }>;
  };
  const hasIndex = (collectionGroup: string, fields: Array<[string, string]>) => indexes.indexes.some((index) => (
    index.collectionGroup === collectionGroup
    && index.queryScope === 'COLLECTION'
    && index.fields.length === fields.length
    && index.fields.every((field, position) => (
      field.fieldPath === fields[position][0] && field.order === fields[position][1]
    ))
  ));
  assert.equal(hasIndex('products', [['category', 'ASCENDING'], ['isActive', 'ASCENDING']]), true);
  assert.equal(hasIndex('products', [['isActive', 'ASCENDING'], ['discount', 'ASCENDING']]), true);
  assert.equal(hasIndex('reviews', [['approved', 'ASCENDING'], ['createdAt', 'DESCENDING']]), true);
  assert.equal(hasIndex('supplier_review_queue', [['batchId', 'ASCENDING'], ['createdAt', 'ASCENDING']]), true);

  const investigation = source('functions/src/api/suppliers/supplierInvestigations.ts');
  assert.match(investigation, /\.where\('batchId', '==', batchId\)\s*\.orderBy\('createdAt', 'asc'\)/u);
});
