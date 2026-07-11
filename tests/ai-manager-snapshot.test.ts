import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order, Product } from '../src/types';
import { buildAIManagerSnapshot } from '../src/features/ai-manager/services/buildAIManagerSnapshot';
import type { AIManagerSourceData } from '../src/features/ai-manager/types/snapshot';

const product: Product = {
  id: 'product-1',
  name: 'Test Product',
  description: 'Test description',
  price: 15000,
  costPrice: 10000,
  marketPrice: 16000,
  imageUrl: 'https://example.com/product.jpg',
  category: 'electronics',
  rating: 4,
  reviewsCount: 1,
  isActive: true,
  stock: 4,
  specs: {},
};

const order: Order = {
  id: 'order-1',
  customerUid: 'customer-private-uid',
  customerName: 'Private Customer',
  customerPhone: '+94 77 000 0000',
  customerEmail: 'private@example.com',
  customerAddress: 'Private address',
  district: 'Colombo',
  items: [{ productId: product.id, name: product.name, price: product.price, quantity: 1, imageUrl: product.imageUrl }],
  totalPrice: 15500,
  status: 'confirmed',
  paymentMethod: 'cod',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function createSource(overrides: Partial<AIManagerSourceData> = {}): AIManagerSourceData {
  return {
    products: [],
    categories: [],
    orders: [],
    customers: [],
    reviews: [],
    supplierSources: [],
    supplierReviewQueue: [],
    supplierSyncHistory: [],
    settings: null,
    ...overrides,
  };
}

test('AI Manager snapshot builds immutable deterministic aggregates', () => {
  const source = createSource({
    products: [product, { ...product, id: 'product-2', stock: 0, isActive: false }],
    orders: [order, { ...order, id: 'order-2', status: 'cancelled', totalPrice: 99999 }],
    customers: [{ uid: 'private', email: 'private@example.com' }],
    reviews: [{ id: 'review-1', productId: product.id, rating: 4 }],
  });

  const snapshot = buildAIManagerSnapshot(source);

  assert.deepEqual(snapshot.metrics, {
    productCount: 2,
    activeProductCount: 1,
    outOfStockCount: 1,
    lowStockCount: 1,
    orderCount: 2,
    nonCancelledRevenue: 15500,
    customerCount: 1,
    reviewCount: 1,
    pendingSupplierReviewCount: 0,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.metrics), true);
  assert.equal(Object.isFrozen(snapshot.intelligence), true);
  assert.deepEqual(buildAIManagerSnapshot(source), snapshot);
});

test('AI Manager readiness reflects available datasets without generating insights', () => {
  const snapshot = buildAIManagerSnapshot(createSource({ products: [product] }));
  const readiness = Object.fromEntries(snapshot.intelligence.map((item) => [item.domain, item.status]));

  assert.equal(readiness.inventory, 'ready');
  assert.equal(readiness.pricing, 'ready');
  assert.equal(readiness.marketing, 'ready');
  assert.equal(readiness.sales, 'limited');
  assert.equal(readiness.customer, 'unavailable');
  assert.equal(readiness.supplier, 'unavailable');
  assert.equal('recommendations' in snapshot, false);
  assert.equal('insights' in snapshot, false);
});

test('AI Manager snapshot excludes customer PII and raw records', () => {
  const snapshot = buildAIManagerSnapshot(createSource({
    orders: [order],
    customers: [{
      uid: 'secret-uid',
      displayName: 'Sensitive Name',
      email: 'sensitive@example.com',
      phone: '+94 11 111 1111',
      address: 'Sensitive Address',
    }],
    reviews: [{
      id: 'review-private',
      productId: product.id,
      customerName: 'Review Customer',
      comment: 'Private review text',
      rating: 5,
    }],
  }));
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.privacy.mode, 'aggregate-only');
  assert.equal(snapshot.privacy.containsCustomerRecords, false);
  assert.equal(snapshot.privacy.containsDirectIdentifiers, false);
  assert.equal(serialized.includes('sensitive@example.com'), false);
  assert.equal(serialized.includes('+94 11 111 1111'), false);
  assert.equal(serialized.includes('Sensitive Address'), false);
  assert.equal(serialized.includes('Private Customer'), false);
  assert.equal(serialized.includes('Private review text'), false);
});
