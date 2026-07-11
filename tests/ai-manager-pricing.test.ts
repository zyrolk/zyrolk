import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePricing } from '../src/features/ai-manager/services/analyzePricing';
import { buildPricingMetrics } from '../src/features/ai-manager/services/buildPricingMetrics';
import type { PricingSnapshot, PricingSnapshotProduct } from '../src/features/ai-manager/types/pricing';

function product(id: string, sellingPrice: number | null, originalPrice: number | null = null, storedDiscount: number | null = null, isActive = true): PricingSnapshotProduct {
  return { id, name: `Product ${id}`, sellingPrice, originalPrice, storedDiscount, isActive };
}
const snapshot = (products: readonly PricingSnapshotProduct[]): PricingSnapshot => ({ products });

test('pricing metrics analyse active products and keep catalogue counts separate', () => {
  const metrics = buildPricingMetrics(snapshot([product('active', 100), product('inactive', -10, null, null, false)]));
  assert.deepEqual(metrics.catalogue, { totalProducts: 2, activeProducts: 1, inactiveProducts: 1 });
  assert.equal(metrics.productsWithSalePrices, 1);
  assert.equal(metrics.productsWithInvalidPricing, 0);
});

test('pricing metrics separate missing, negative, non-finite, and selling-above-original categories', () => {
  const metrics = buildPricingMetrics(snapshot([
    product('missing-null', null), product('missing-zero', 0), product('negative', -1),
    product('nan', Number.NaN), product('infinity', Number.POSITIVE_INFINITY),
    product('original-nan', 50, Number.NaN), product('original-negative', 50, -1), product('above-original', 101, 100),
  ]));
  const issues = Object.fromEntries(metrics.invalidPricing.map((item) => [item.category, item.count]));
  assert.equal(issues['missing-selling-price'], 2);
  assert.equal(issues['negative-selling-price'], 1);
  assert.equal(issues['non-finite-selling-price'], 2);
  assert.equal(issues['non-finite-original-price'], 1);
  assert.equal(issues['non-positive-original-price'], 1);
  assert.equal(issues['selling-above-original'], 1);
  assert.equal(metrics.productsWithInvalidPricing, 6);
  assert.equal(metrics.health.status, 'critical');
  assert.equal(metrics.productIssues.find((item) => item.id === 'above-original')?.categories.includes('selling-above-original'), true);
});

test('discount coverage is always derived from selling and original prices', () => {
  const metrics = buildPricingMetrics(snapshot([
    product('derived', 80, 100, 5),
    product('stored-only', 100, null, 50),
  ]));
  assert.equal(metrics.discounts.discountedProducts, 1);
  assert.equal(metrics.discounts.coveragePercentage, 50);
  const consistency = Object.fromEntries(metrics.consistencyIssues.map((item) => [item.category, item.count]));
  assert.equal(consistency['stored-discount-mismatch'], 2);
});

test('discount bucket floating-point boundaries remain deterministic around 10, 20, and 30 percent', () => {
  const metrics = buildPricingMetrics(snapshot([
    product('ten', 90, 100), product('above-ten', 89.999, 100),
    product('twenty', 80, 100), product('above-twenty', 79.999, 100),
    product('thirty', 70, 100), product('above-thirty', 69.999, 100),
  ]));
  const buckets = Object.fromEntries(metrics.discounts.distribution.map((item) => [item.key, item.count]));
  assert.equal(buckets['up-to-10'], 1);
  assert.equal(buckets['up-to-20'], 2);
  assert.equal(buckets['up-to-30'], 2);
  assert.equal(buckets['above-30'], 1);
});

test('pricing distribution calculates average, median, and factual rankings', () => {
  const metrics = buildPricingMetrics(snapshot([product('low', 100), product('middle', 200), product('high', 500), product('invalid', -10)]));
  assert.equal(metrics.prices.averageSellingPrice, 800 / 3);
  assert.equal(metrics.prices.medianSellingPrice, 200);
  assert.equal(metrics.prices.highestPricedProducts[0].name, 'Product high');
  assert.equal(metrics.prices.highestPricedProducts[0].sellingPrice, 500);
  assert.equal(metrics.prices.lowestPricedProducts[0].name, 'Product low');
  assert.equal(metrics.prices.lowestPricedProducts[0].sellingPrice, 100);
});

test('pricing health documents the 20 percent threshold and factual empty states', () => {
  const healthy = buildPricingMetrics(snapshot([
    product('discounted', 80, 100), product('a', 100), product('b', 100), product('c', 100), product('d', 100),
  ]));
  assert.equal(healthy.discounts.coveragePercentage, 20);
  assert.equal(healthy.health.status, 'healthy');
  assert.equal(healthy.health.healthyDiscountThreshold, 20);

  const attention = buildPricingMetrics(snapshot([product('a', 100), product('b', 100)]));
  assert.equal(attention.health.status, 'attention');
  assert.equal(attention.health.reasons.some((reason) => reason.includes('20%')), true);

  const unavailable = buildPricingMetrics(snapshot([product('inactive', 100, null, null, false)]));
  const analysis = analyzePricing(unavailable);
  assert.equal(unavailable.health.status, 'unavailable');
  assert.deepEqual(analysis.insights.map((item) => item.code), ['pricing-no-active-products']);
});

test('pricing results are immutable and deterministic', () => {
  const first = buildPricingMetrics(snapshot([product('a', 80, 100)]));
  const second = buildPricingMetrics(snapshot([product('a', 80, 100)]));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.discounts.distribution), true);
  assert.deepEqual(analyzePricing(first), analyzePricing(second));
});
