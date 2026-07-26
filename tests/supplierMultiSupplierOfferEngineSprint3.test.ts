import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierOfferId,
  buildSupplierProductOffer,
  parseSupplierOfferSelection,
  resolveActiveSupplierOffer,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from '../functions/src/api/suppliers/supplierOfferEngine';

const offer = (sourceId: string, priority: number, overrides: Record<string, unknown> = {}) => buildSupplierProductOffer({
  sourceId,
  supplierId: sourceId,
  supplierProductId: `${sourceId}-product`,
  sku: 'COMMON-SKU',
  barcode: '123456789',
  productId: 'zyro-product',
  price: 1200,
  cost: 900,
  stock: 5,
  priority,
  health: { availability: 'available' },
  lastSyncAt: '2026-07-26T00:00:00.000Z',
  catalogPayload: { id: 'zyro-product', name: 'Product' },
  supplierSnapshot: { supplierProductId: `${sourceId}-product` },
  timestamp: '2026-07-26T00:00:00.000Z',
  ...overrides,
});

test('Sprint 3 gives every source product a stable independent offer identity', () => {
  assert.equal(buildSupplierOfferId('source-a', 'product-1', 'SKU-1'), buildSupplierOfferId('source-a', 'product-1', 'SKU-2'));
  assert.notEqual(buildSupplierOfferId('source-a', 'product-1', 'SKU-1'), buildSupplierOfferId('source-b', 'product-1', 'SKU-1'));
  assert.equal(SUPPLIER_PRODUCT_OFFERS_COLLECTION, 'supplier_product_offers');
});

test('Sprint 3 offer records preserve required commercial, health, sync, and ownership metadata', () => {
  const record = offer('source-a', 100);
  assert.deepEqual({
    supplierId: record.supplierId,
    supplierProductId: record.supplierProductId,
    sku: record.sku,
    barcode: record.barcode,
    price: record.price,
    cost: record.cost,
    stock: record.stock,
    availability: record.availability,
    priority: record.priority,
    lastSyncAt: record.lastSyncAt,
  }, {
    supplierId: 'source-a', supplierProductId: 'source-a-product', sku: 'COMMON-SKU', barcode: '123456789',
    price: 1200, cost: 900, stock: 5, availability: 'in_stock', priority: 100,
    lastSyncAt: '2026-07-26T00:00:00.000Z',
  });
  assert.equal(record.health.availability, 'available');
  assert.ok(record.ownership.supplier.includes('price'));
  assert.ok(record.ownership.admin.includes('priority'));
  assert.ok(record.ownership.system.includes('productId'));
});

test('Sprint 3 preserves admin priority and enabled decisions during repeated supplier syncs', () => {
  const first = offer('source-a', 100);
  const configured = { ...first, priority: 275, enabled: false };
  const repeated = offer('source-a', 999, {
    price: 1350,
    stock: 8,
    existing: configured,
    timestamp: '2026-07-26T01:00:00.000Z',
  });
  assert.equal(repeated.priority, 275);
  assert.equal(repeated.enabled, false);
  assert.equal(repeated.price, 1350);
  assert.equal(repeated.stock, 8);
  assert.equal(repeated.sourceId, 'source-a');
});

test('Sprint 3 updates only the matching supplier offer when suppliers share a storefront product', () => {
  const supplierA = offer('source-a', 100);
  const supplierB = offer('source-b', 80, { cost: 850, stock: 12 });
  const supplierAUpdate = offer('source-a', 100, {
    existing: supplierA,
    cost: 925,
    stock: 3,
    timestamp: '2026-07-26T02:00:00.000Z',
  });
  assert.notEqual(supplierAUpdate.id, supplierB.id);
  assert.equal(supplierAUpdate.cost, 925);
  assert.equal(supplierAUpdate.stock, 3);
  assert.equal(supplierB.cost, 850);
  assert.equal(supplierB.stock, 12);
  assert.equal(supplierAUpdate.productId, supplierB.productId);
});

test('Sprint 3 resolves active, failover, locked, and disabled offers deterministically', () => {
  const high = offer('source-a', 100);
  const low = offer('source-b', 80);
  assert.equal(resolveActiveSupplierOffer([low, high], {}).id, high.id);

  const failedHigh = { ...high, stock: 0, availability: 'out_of_stock' as const };
  assert.equal(resolveActiveSupplierOffer([failedHigh, low], { activeOfferId: high.id, failoverEnabled: true })?.id, low.id);
  assert.equal(resolveActiveSupplierOffer([failedHigh, low], { activeOfferId: high.id, failoverEnabled: false })?.id, high.id);
  assert.equal(resolveActiveSupplierOffer([failedHigh, low], { lockedOfferId: high.id, failoverEnabled: true })?.id, high.id);
  assert.equal(resolveActiveSupplierOffer([{ ...high, enabled: false }, low], { activeOfferId: high.id })?.id, low.id);
});

test('Sprint 3 selection defaults keep legacy products operational without migration', () => {
  assert.deepEqual(parseSupplierOfferSelection(undefined), {
    activeOfferId: null,
    lockedOfferId: null,
    failoverEnabled: true,
  });
});

test('Sprint 3 integration keeps offers server-authoritative and products storefront-authoritative', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');

  assert.match(rules, /match \/supplier_product_offers\/\{docId\}[\s\S]*allow create, update, delete: if false;/);
  assert.match(sync, /SUPPLIER_PRODUCT_OFFERS_COLLECTION/);
  assert.match(sync, /buildSupplierProductOffer/);
  assert.match(sync, /comparisonBaseline = ownOffer/);
  assert.match(sync, /supplier_offer_attached_to_canonical_product/);
  assert.match(approval, /supplierOfferSelection/);
  assert.match(routes, /supplier-products\/:productId\/offers/);
});
