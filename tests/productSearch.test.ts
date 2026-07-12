import assert from 'node:assert/strict';
import test from 'node:test';
import { searchAdminProducts } from '../src/services/product-search/adminProductSearch';
import { projectCustomerProduct } from '../src/services/product-search/customerProjection';
import { searchCustomerProducts } from '../src/services/product-search/customerProductSearch';
import type { Product } from '../src/types';

const makeProduct = (overrides: Partial<Product> & Record<string, unknown> = {}): Product & Record<string, unknown> => ({
  id: 'firestore-internal-id',
  name: 'Zyro Smart Watch 2',
  description: 'Private description phrase',
  price: 12_500,
  originalPrice: 15_000,
  discount: 17,
  imageUrl: '/watch.webp',
  category: 'Wearable Tech',
  rating: 4.5,
  reviewsCount: 24,
  isNew: true,
  isFeatured: true,
  isBestSeller: false,
  isActive: true,
  sku: 'ZY-WATCH-2',
  stock: 8,
  specs: { Brand: 'Zyro', Model: 'SW 200', Colour: 'Midnight' },
  supplierItemCode: 'SUP-ITEM-44',
  costPrice: 8_000,
  supplierCode: 'SUP-CODE-9',
  supplierMetadata: { secret: true },
  connectorMetadata: { token: 'hidden' },
  internalId: 'internal-secondary-id',
  ...overrides,
});

test('customer projection is an explicit immutable allowlist', () => {
  const source = makeProduct();
  const projected = projectCustomerProduct(source);
  assert.deepEqual(Object.keys(projected).sort(), [
    'brand', 'category', 'id', 'image', 'isBestSeller', 'isFeatured', 'isNew',
    'model', 'rating', 'reviewCount', 'salePrice', 'sellingPrice', 'stock', 'name',
  ].sort());
  assert.equal(Object.isFrozen(projected), true);
  for (const forbidden of ['supplierCode', 'supplierItemCode', 'sku', 'costPrice', 'supplierMetadata', 'connectorMetadata', 'internalId']) {
    assert.equal(forbidden in projected, false);
  }
});

test('customer search matches only name, brand, model, and category', () => {
  const projected = [projectCustomerProduct(makeProduct())];
  for (const query of ['smart', 'ZYRO', 'sw 2', 'wearable']) {
    assert.equal(searchCustomerProducts(projected, query).length, 1, query);
  }
  for (const forbiddenQuery of ['private description', 'ZY-WATCH', 'SUP-CODE', 'SUP-ITEM', 'firestore-internal', 'midnight']) {
    assert.equal(searchCustomerProducts(projected, forbiddenQuery).length, 0, forbiddenQuery);
  }
});

test('customer search normalizes whitespace and supports partial, numeric, Unicode, and Sinhala queries', () => {
  const products = [projectCustomerProduct(makeProduct({
    name: 'දුරකථන  2026',
    specs: { Brand: 'Élan', Model: 'A  55' },
  }))];
  for (const query of ['  දුරකථන  ', '2026', 'éLAN', '  a   55  ', 'රකථ']) {
    assert.equal(searchCustomerProducts(products, query).length, 1, query);
  }
  assert.equal(searchCustomerProducts(products, 'x'.repeat(10_000)).length, 0);
});

test('customer search preserves stable source ordering', () => {
  const products = ['first', 'second', 'third'].map((id) => projectCustomerProduct(makeProduct({ id, name: `Phone ${id}` })));
  assert.deepEqual(searchCustomerProducts(products, 'phone').map((product) => product.id), ['first', 'second', 'third']);
});

test('admin search covers approved metadata but never Firestore document ids', () => {
  const products = [makeProduct()];
  for (const query of ['smart watch', 'SUP-CODE', 'SUP-ITEM', 'ZY-WATCH', 'zyro', 'sw 200', 'wearable']) {
    assert.equal(searchAdminProducts(products, query).length, 1, query);
  }
  assert.equal(searchAdminProducts(products, 'firestore-internal-id').length, 0);
});
