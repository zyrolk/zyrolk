import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSales } from '../src/features/ai-manager/services/analyzeSales';
import { buildSalesMetrics } from '../src/features/ai-manager/services/buildSalesMetrics';
import type { SalesSnapshot, SalesSnapshotOrder } from '../src/features/ai-manager/types/sales';

const localTimestamp = (year: number, monthIndex: number, day: number, hour = 12) => (
  new Date(year, monthIndex, day, hour).toISOString()
);

function order(overrides: Partial<SalesSnapshotOrder> = {}): SalesSnapshotOrder {
  return {
    createdAt: localTimestamp(2024, 2, 1),
    status: 'confirmed',
    totalPrice: 1000,
    items: [{ productId: 'product-a', productName: 'Product A', unitPrice: 1000, quantity: 1 }],
    ...overrides,
  };
}

const snapshot = (orders: readonly SalesSnapshotOrder[]): SalesSnapshot => ({ orders });

test('sales metrics calculate today, 7-day, 30-day, revenue, order, and average totals', () => {
  const metrics = buildSalesMetrics(snapshot([
    order({ createdAt: localTimestamp(2024, 2, 1), totalPrice: 1000 }),
    order({ createdAt: localTimestamp(2024, 1, 28), totalPrice: 2000 }),
    order({ createdAt: localTimestamp(2024, 1, 20), totalPrice: 1000 }),
    order({ createdAt: localTimestamp(2024, 2, 1), status: 'cancelled', totalPrice: 9000 }),
  ]), new Date(2024, 2, 1, 18));

  assert.equal(metrics.today.revenue, 1000);
  assert.equal(metrics.today.orderCount, 1);
  assert.equal(metrics.lastSevenDays.revenue, 3000);
  assert.equal(metrics.lastSevenDays.orderCount, 2);
  assert.equal(metrics.lastSevenDays.averageOrderValue, 1500);
  assert.equal(metrics.lastThirtyDays.revenue, 4000);
  assert.equal(metrics.revenueSummary.totalRevenue, 4000);
  assert.equal(metrics.revenueSummary.totalOrderCount, 3);
  assert.equal(metrics.orderBreakdown.totalOrders, 4);
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(Object.isFrozen(metrics.revenueRanking.highest), true);
});

test('sales trend percentages compare the current and previous 7-day periods', () => {
  const metrics = buildSalesMetrics(snapshot([
    order({ createdAt: localTimestamp(2024, 1, 24), totalPrice: 200 }),
    order({ createdAt: localTimestamp(2024, 2, 1), totalPrice: 100 }),
    order({ createdAt: localTimestamp(2024, 1, 20), totalPrice: 100 }),
  ]), new Date(2024, 2, 1, 18));

  assert.equal(metrics.revenueSummary.revenueTrend.currentValue, 300);
  assert.equal(metrics.revenueSummary.revenueTrend.previousValue, 100);
  assert.equal(metrics.revenueSummary.revenueTrend.percentageChange, 200);
  assert.equal(metrics.revenueSummary.orderTrend.percentageChange, 100);

  const analysis = analyzeSales(metrics);
  assert.equal(analysis.insights.some((item) => item.message.includes('200.0%')), true);
  assert.equal(analysis.insights.some((item) => item.message.includes('100.0%')), true);
  assert.equal(Object.isFrozen(analysis), true);
});

test('sales rankings keep revenue and quantity ordering separate', () => {
  const metrics = buildSalesMetrics(snapshot([
    order({
      totalPrice: 2000,
      items: [{ productId: 'premium', productName: 'Premium Product', unitPrice: 2000, quantity: 1 }],
    }),
    order({
      totalPrice: 1000,
      items: [{ productId: 'volume', productName: 'Volume Product', unitPrice: 100, quantity: 10 }],
    }),
  ]), new Date(2024, 2, 1, 18));

  assert.equal(metrics.revenueRanking.highest[0].productName, 'Premium Product');
  assert.equal(metrics.revenueRanking.lowest[0].productName, 'Volume Product');
  assert.equal(metrics.quantityRanking.highest[0].productName, 'Volume Product');
  assert.equal(metrics.quantityRanking.lowest[0].productName, 'Premium Product');
});

test('sales metrics handle leap day and month-end calendar boundaries', () => {
  const leapDayMetrics = buildSalesMetrics(snapshot([
    order({ createdAt: localTimestamp(2024, 1, 29), totalPrice: 290 }),
    order({ createdAt: localTimestamp(2024, 1, 1), totalPrice: 100 }),
    order({ createdAt: localTimestamp(2024, 0, 31), totalPrice: 310 }),
  ]), new Date(2024, 1, 29, 20));

  assert.equal(leapDayMetrics.today.startDate, '2024-02-29');
  assert.equal(leapDayMetrics.today.revenue, 290);
  assert.equal(leapDayMetrics.lastThirtyDays.startDate, '2024-01-31');
  assert.equal(leapDayMetrics.lastThirtyDays.endDate, '2024-02-29');
  assert.equal(leapDayMetrics.lastThirtyDays.revenue, 700);
  assert.equal(leapDayMetrics.revenueTrend.length, 30);

  const monthEndMetrics = buildSalesMetrics(snapshot([
    order({ createdAt: localTimestamp(2024, 3, 30), totalPrice: 300 }),
    order({ createdAt: localTimestamp(2024, 3, 1), totalPrice: 100 }),
    order({ createdAt: localTimestamp(2024, 2, 31), totalPrice: 999 }),
  ]), new Date(2024, 3, 30, 20));

  assert.equal(monthEndMetrics.lastThirtyDays.startDate, '2024-04-01');
  assert.equal(monthEndMetrics.lastThirtyDays.endDate, '2024-04-30');
  assert.equal(monthEndMetrics.lastThirtyDays.revenue, 400);
});

test('sales metrics ignore invalid dates in periods and return factual empty states', () => {
  const emptyMetrics = buildSalesMetrics(snapshot([]), new Date(2024, 2, 1, 12));
  const emptyAnalysis = analyzeSales(emptyMetrics);

  assert.equal(emptyMetrics.today.hasSales, false);
  assert.equal(emptyMetrics.today.averageOrderValue, null);
  assert.equal(emptyMetrics.revenueRanking.highest.length, 0);
  assert.deepEqual(emptyAnalysis.insights.map((item) => item.code), ['sales-no-orders']);

  const invalidDateMetrics = buildSalesMetrics(snapshot([
    order({ createdAt: 'not-a-date', totalPrice: 500 }),
  ]), new Date(2024, 2, 1, 12));

  assert.equal(invalidDateMetrics.today.hasSales, false);
  assert.equal(invalidDateMetrics.lastThirtyDays.orderCount, 0);
  assert.equal(invalidDateMetrics.revenueSummary.totalRevenue, 500);
  assert.throws(() => buildSalesMetrics(snapshot([]), new Date('invalid')), RangeError);
});

test('sales no-baseline trend does not fabricate a percentage', () => {
  const metrics = buildSalesMetrics(snapshot([
    order({ createdAt: localTimestamp(2024, 2, 1), totalPrice: 500 }),
  ]), new Date(2024, 2, 1, 12));
  const analysis = analyzeSales(metrics);

  assert.equal(metrics.revenueSummary.revenueTrend.direction, 'no-baseline');
  assert.equal(metrics.revenueSummary.revenueTrend.percentageChange, null);
  assert.equal(analysis.insights.some((item) => item.code === 'sales-revenue-new-baseline'), true);
  assert.equal(analysis.insights.some((item) => item.message.includes('%')), false);
});
