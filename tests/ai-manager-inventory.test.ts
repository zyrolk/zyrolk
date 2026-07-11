import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeInventory } from '../src/features/ai-manager/services/analyzeInventory';
import { buildInventoryMetrics } from '../src/features/ai-manager/services/buildInventoryMetrics';
import type { InventorySnapshot, InventorySnapshotProduct } from '../src/features/ai-manager/types/inventory';

function product(id: string, stock: number | null, isActive = true): InventorySnapshotProduct {
  return { id, name: `Product ${id}`, stock, isActive };
}
const snapshot = (products: readonly InventorySnapshotProduct[]): InventorySnapshot => ({ products });

test('inventory metrics classify catalogue and active stock without overlapping totals', () => {
  const metrics = buildInventoryMetrics(snapshot([
    product('out', 0), product('low-one', 1), product('low-five', 5), product('healthy', 6), product('inactive', 0, false),
  ]));

  assert.deepEqual(metrics.summary, {
    totalProducts: 5, activeProducts: 4, inactiveProducts: 1, inStockProducts: 3,
    outOfStockProducts: 1, lowStockProducts: 2, invalidStockProducts: 0,
  });
  assert.deepEqual(metrics.lowStockProducts.map((item) => item.stock), [1, 5]);
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(Object.isFrozen(metrics.stockDistribution.items), true);
});

test('inventory distribution reports factual active-product counts and percentages', () => {
  const metrics = buildInventoryMetrics(snapshot([
    product('healthy', 10), product('low', 3), product('out', 0), product('invalid', null),
  ]));
  const distribution = Object.fromEntries(metrics.stockDistribution.items.map((item) => [item.key, item]));

  assert.equal(distribution.healthy.count, 1);
  assert.equal(distribution.healthy.percentage, 25);
  assert.equal(distribution.low.percentage, 25);
  assert.equal(distribution.out.percentage, 25);
  assert.equal(distribution.invalid.percentage, 25);
});

test('negative, null, NaN, and infinite stock are invalid rather than out of stock', () => {
  const metrics = buildInventoryMetrics(snapshot([
    product('negative', -1), product('null', null), product('nan', Number.NaN),
    product('infinity', Number.POSITIVE_INFINITY), product('out', 0),
  ]));

  assert.equal(metrics.summary.invalidStockProducts, 4);
  assert.equal(metrics.summary.outOfStockProducts, 1);
  assert.equal(metrics.summary.inStockProducts, 0);
  const analysis = analyzeInventory(metrics);
  assert.equal(analysis.insights.some((item) => item.code === 'inventory-invalid-stock'), true);
  assert.equal(analysis.insights.find((item) => item.code === 'inventory-invalid-stock')?.message.includes('excluded'), true);
});

test('inventory health rules expose good, attention, and critical boundaries', () => {
  const tenProducts = Array.from({ length: 10 }, (_, index) => product(`p-${index}`, index === 0 ? 5 : 10));
  assert.equal(buildInventoryMetrics(snapshot(tenProducts)).health.status, 'good');

  const attentionProducts = Array.from({ length: 4 }, (_, index) => product(`a-${index}`, index === 0 ? 0 : 10));
  const attention = buildInventoryMetrics(snapshot(attentionProducts));
  assert.equal(attention.health.status, 'attention');
  assert.equal(attention.health.affectedPercentage, 25);
  assert.equal(attention.health.reasoning.includes('25.0%'), true);

  const criticalProducts = Array.from({ length: 4 }, (_, index) => product(`c-${index}`, index < 2 ? 5 : 10));
  assert.equal(buildInventoryMetrics(snapshot(criticalProducts)).health.status, 'critical');
});

test('inventory empty states remain factual', () => {
  const emptyMetrics = buildInventoryMetrics(snapshot([]));
  const emptyAnalysis = analyzeInventory(emptyMetrics);
  assert.equal(emptyMetrics.hasProducts, false);
  assert.equal(emptyMetrics.health.status, 'unavailable');
  assert.deepEqual(emptyAnalysis.insights.map((item) => item.code), ['inventory-no-products', 'inventory-inactive-products']);

  const inactiveMetrics = buildInventoryMetrics(snapshot([product('inactive', 3, false)]));
  assert.equal(inactiveMetrics.health.status, 'unavailable');
  assert.equal(inactiveMetrics.summary.lowStockProducts, 0);
  assert.equal(analyzeInventory(inactiveMetrics).insights.some((item) => item.code === 'inventory-no-active-products'), true);
});

test('inventory insights are deterministic and contain no confidence scores', () => {
  const metrics = buildInventoryMetrics(snapshot([product('healthy', 10)]));
  const first = analyzeInventory(metrics);
  const second = analyzeInventory(metrics);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).toLowerCase().includes('confidence'), false);
  assert.equal(Object.isFrozen(first), true);
});
