import assert from 'node:assert/strict';
import test from 'node:test';
import * as browserPolicy from '../src/services/supplierSyncSettings';
import * as scheduledPolicy from '../functions/src/scheduled/supplierSyncSettings';

const policies = [browserPolicy, scheduledPolicy];

test('supplier source product limits honor saved values and safety maximums', () => {
  policies.forEach(({ getSupplierProductLimit, limitSupplierProducts, resolveSupplierProductLimit }) => {
    assert.equal(getSupplierProductLimit('5'), 5);
    assert.equal(getSupplierProductLimit('20'), 20);
    assert.equal(getSupplierProductLimit('250'), 250);
    assert.equal(getSupplierProductLimit('All'), 250);
    assert.equal(getSupplierProductLimit('500'), 250);
    assert.equal(getSupplierProductLimit('invalid', 250), 250);
    const products = Array.from({ length: 120 }, (_, index) => ({ id: index + 1 }));
    for (const value of [5, 20, 50, 100]) {
      assert.equal(resolveSupplierProductLimit(String(value), undefined, 250), value);
      assert.equal(resolveSupplierProductLimit(undefined, value, 250), value);
      assert.equal(resolveSupplierProductLimit(String(value), 100, 250), value);
      assert.equal(limitSupplierProducts(products, value).length, value);
    }
    assert.equal(resolveSupplierProductLimit(undefined, undefined, 250), 250);
    assert.equal(resolveSupplierProductLimit('All', 20, 100), 100);
  });
});

test('image limits and initial pricing use persisted financial settings consistently', () => {
  policies.forEach(({ calculateSupplierInitialPricing, getSupplierImageLimit }) => {
    assert.equal(getSupplierImageLimit(3), 3);
    assert.equal(getSupplierImageLimit(50), 20);
    assert.equal(getSupplierImageLimit(''), 5);
    assert.deepEqual(calculateSupplierInitialPricing(1000, 1500, 10, 15), {
      sellingPrice: 1250,
      comparePrice: 1500,
      discountPercent: 17,
    });
    assert.deepEqual(calculateSupplierInitialPricing(0, 900, 10, 15), {
      sellingPrice: 900,
      comparePrice: 900,
      discountPercent: 0,
    });
    assert.equal(calculateSupplierInitialPricing(1000, 1500, undefined, undefined).sellingPrice, 1250);
  });
});

test('every persisted supplier sync-mode flag filters its own change group', () => {
  policies.forEach(({ filterSupplierComparison }) => {
    assert.equal(filterSupplierComparison({ status: 'NEW_PRODUCT', changedFields: [] }, { syncNewProducts: false }), null);
    assert.equal(filterSupplierComparison({ status: 'PRICE_CHANGED', changedFields: ['Cost Price'] }, { syncPriceUpdates: false }), null);
    assert.equal(filterSupplierComparison({ status: 'STOCK_CHANGED', changedFields: ['Stock'] }, { syncStockUpdates: false }), null);
    assert.equal(filterSupplierComparison({ status: 'DESCRIPTION_CHANGED', changedFields: ['Description'] }, { syncDescriptionUpdates: false }), null);
    assert.equal(filterSupplierComparison({ status: 'IMAGE_CHANGED', changedFields: ['Primary Image'] }, { syncImageUpdates: false }), null);
    assert.equal(filterSupplierComparison({ status: 'IMAGE_CHANGED', changedFields: ['Images'] }, { syncImageUpdates: false }), null);

    assert.deepEqual(
      filterSupplierComparison(
        { status: 'PRICE_CHANGED', changedFields: ['Cost Price', 'Stock', 'Primary Image'] },
        { syncPriceUpdates: false, syncStockUpdates: true, syncImageUpdates: false },
      ),
      { status: 'STOCK_CHANGED', changedFields: ['Stock'] },
    );
  });
});

test('supplier category discovery is normalized, deduplicated, and deterministic', () => {
  policies.forEach(({ collectDiscoveredSupplierCategories }) => {
    assert.deepEqual(collectDiscoveredSupplierCategories([
      { categoryHierarchy: [' Smart Gadgets ', 'Electronics'] },
      { categoryHierarchy: ['smart gadgets', 'Home & Kitchen'] },
    ]), ['Electronics', 'Home & Kitchen', 'Smart Gadgets']);
  });
});

test('per-source auto sync intervals enforce Off and due timestamps', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z');
  policies.forEach(({ isSupplierSourceAutoSyncDue }) => {
    assert.equal(isSupplierSourceAutoSyncDue('Off', undefined, now), false);
    assert.equal(isSupplierSourceAutoSyncDue('15 Minutes', now - 14 * 60 * 1000, now), false);
    assert.equal(isSupplierSourceAutoSyncDue('15 Minutes', now - 15 * 60 * 1000, now), true);
    assert.equal(isSupplierSourceAutoSyncDue('Daily', { toMillis: () => now - 24 * 60 * 60 * 1000 }, now), true);
    assert.equal(isSupplierSourceAutoSyncDue('1 Hour', now + 5 * 60 * 60 * 1000, now), true);
  });
});
