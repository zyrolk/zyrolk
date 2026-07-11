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
    supplierPendingChanges: [],
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
  assert.equal(Object.isFrozen(snapshot.inventory.products), true);
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
  assert.equal(snapshot.sales.orders.length, 1);
  assert.deepEqual(Object.keys(snapshot.sales.orders[0]).sort(), ['createdAt', 'items', 'status', 'totalPrice']);
  assert.equal(serialized.includes('sensitive@example.com'), false);
  assert.equal(serialized.includes('+94 11 111 1111'), false);
  assert.equal(serialized.includes('Sensitive Address'), false);
  assert.equal(serialized.includes('Private Customer'), false);
  assert.equal(serialized.includes('Private review text'), false);
});

test('AI Manager inventory snapshot is minimal and preserves invalid stock for analysis', () => {
  const nullStockProduct = { ...product, id: 'null-stock', stock: null } as unknown as Product;
  const snapshot = buildAIManagerSnapshot(createSource({ products: [product, nullStockProduct] }));

  assert.deepEqual(Object.keys(snapshot.inventory.products[0]).sort(), ['id', 'isActive', 'name', 'stock']);
  assert.equal(snapshot.inventory.products[0].stock, 4);
  assert.equal(snapshot.inventory.products[1].stock, null);
  assert.equal(JSON.stringify(snapshot.inventory).includes('description'), false);
  assert.equal(JSON.stringify(snapshot.inventory).includes('price'), false);
});

test('AI Manager supplier snapshot is minimal and excludes sensitive connector data', () => {
  const snapshot = buildAIManagerSnapshot(createSource({
    supplierSources: [{
      id: 'supplier-a', name: 'Supplier A', sourceStatus: 'active', lastSync: '2026-03-01T00:00:00.000Z',
      connectorUrl: 'https://secret.example.com', apiKey: 'secret-key',
    } as AIManagerSourceData['supplierSources'][number] & { connectorUrl: string; apiKey: string }],
    supplierSyncHistory: [{ supplierId: 'supplier-a', supplierName: 'Supplier A', timestamp: '2026-03-01T00:00:00.000Z', status: 'Success', pendingReviews: 2 }],
    supplierPendingChanges: [{ id: 'change-1', reviewQueueItemId: 'review-1', sourceId: 'supplier-a', status: 'Pending' }],
  }));
  const serialized = JSON.stringify(snapshot.suppliers);

  assert.deepEqual(Object.keys(snapshot.suppliers.suppliers[0]).sort(), ['id', 'isEnabled', 'lastSync', 'name']);
  assert.deepEqual(Object.keys(snapshot.suppliers.syncHistory[0]).sort(), ['pendingReviews', 'status', 'supplierId', 'supplierName', 'timestamp']);
  assert.equal(serialized.includes('secret.example.com'), false);
  assert.equal(serialized.includes('secret-key'), false);
  assert.equal(serialized.includes('connectorUrl'), false);
  assert.equal(Object.isFrozen(snapshot.suppliers), true);
});

test('AI Manager pricing snapshot is minimal and preserves invalid numeric values for analysis', () => {
  const invalidProduct = { ...product, id: 'invalid-price', price: Number.NaN, originalPrice: Number.POSITIVE_INFINITY, discount: -2 };
  const snapshot = buildAIManagerSnapshot(createSource({ products: [product, invalidProduct] }));

  assert.deepEqual(Object.keys(snapshot.pricing.products[0]).sort(), ['id', 'isActive', 'name', 'originalPrice', 'sellingPrice', 'storedDiscount']);
  assert.equal(Number.isNaN(snapshot.pricing.products[1].sellingPrice), true);
  assert.equal(snapshot.pricing.products[1].originalPrice, Number.POSITIVE_INFINITY);
  assert.equal(snapshot.pricing.products[1].storedDiscount, -2);
  assert.equal(JSON.stringify(snapshot.pricing.products[0]).includes('description'), false);
  assert.equal(Object.isFrozen(snapshot.pricing.products), true);
});
