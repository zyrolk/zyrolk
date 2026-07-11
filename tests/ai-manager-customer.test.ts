import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCustomers } from '../src/features/ai-manager/services/analyzeCustomers';
import { buildAIManagerSnapshot } from '../src/features/ai-manager/services/buildAIManagerSnapshot';
import { buildCustomerMetrics } from '../src/features/ai-manager/services/buildCustomerMetrics';
import type { AnonymousCustomerPurchaseProfile, CustomerSnapshot } from '../src/features/ai-manager/types/customer';
import type { AIManagerSourceData } from '../src/features/ai-manager/types/snapshot';
import type { Order } from '../src/types';

function order(id: string, email: string, uid: string, createdAt: string, totalPrice = 100, status: Order['status'] = 'confirmed'): Order {
  return { id, customerUid: uid, customerName: 'Private Name', customerPhone: '0770000000', customerEmail: email, customerAddress: 'Private Address', district: 'Colombo', items: [], totalPrice, status, paymentMethod: 'cod', createdAt };
}
function source(orders: readonly Order[], customerCount = 0): AIManagerSourceData {
  return { products: [], categories: [], orders, customers: Array.from({ length: customerCount }, () => ({})), reviews: [], supplierSources: [], supplierReviewQueue: [], supplierPendingChanges: [], supplierSyncHistory: [], settings: null };
}
function profile(orderDates: readonly string[], lifetimeValue = orderDates.length * 100): AnonymousCustomerPurchaseProfile {
  return { orderCount: orderDates.length, lifetimeValue, orderDates };
}
const customerSnapshot = (profiles: readonly AnonymousCustomerPurchaseProfile[], customerRecordCount = profiles.length): CustomerSnapshot => ({ customerRecordCount, purchaseProfiles: profiles, excludedOrderCount: 0 });

test('customer snapshot normalizes email case and never exposes transient grouping keys', () => {
  const snapshot = buildAIManagerSnapshot(source([
    order('one', 'Buyer@Example.com', 'guest', '2026-03-01T12:00:00.000Z'),
    order('two', ' buyer@example.COM ', 'guest', '2026-03-02T12:00:00.000Z'),
  ], 1)).customers;
  assert.equal(snapshot.purchaseProfiles.length, 1);
  assert.equal(snapshot.purchaseProfiles[0].orderCount, 2);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('buyer@example'), false);
  assert.deepEqual(Object.keys(snapshot.purchaseProfiles[0]).sort(), ['lifetimeValue', 'orderCount', 'orderDates']);
});

test('customer snapshot uses non-guest UID fallback without exposing the UID', () => {
  const snapshot = buildAIManagerSnapshot(source([
    order('one', '', 'USER-1', '2026-03-01T12:00:00.000Z'),
    order('two', '', 'user-1', '2026-03-02T12:00:00.000Z'),
  ])).customers;
  assert.equal(snapshot.purchaseProfiles.length, 1);
  assert.equal(snapshot.purchaseProfiles[0].orderCount, 2);
  assert.equal(JSON.stringify(snapshot).includes('user-1'), false);
});

test('guest orders remain isolated by email and unidentifiable guests are excluded', () => {
  const snapshot = buildAIManagerSnapshot(source([
    order('one', 'first@example.com', 'guest', '2026-03-01T12:00:00.000Z'),
    order('two', 'second@example.com', 'guest', '2026-03-02T12:00:00.000Z'),
    order('three', '', 'guest', '2026-03-03T12:00:00.000Z'),
    order('four', '', 'guest', '2026-03-04T12:00:00.000Z'),
  ])).customers;
  assert.equal(snapshot.purchaseProfiles.length, 2);
  assert.deepEqual(snapshot.purchaseProfiles.map((item) => item.orderCount), [1, 1]);
  assert.equal(snapshot.excludedOrderCount, 2);
});

test('duplicate orders are counted once and cancelled orders are excluded', () => {
  const duplicate = order('duplicate', 'buyer@example.com', 'guest', '2026-03-01T12:00:00.000Z', 200);
  const snapshot = buildAIManagerSnapshot(source([duplicate, { ...duplicate }, order('cancelled', 'buyer@example.com', 'guest', '2026-03-02T12:00:00.000Z', 900, 'cancelled')])).customers;
  assert.equal(snapshot.purchaseProfiles[0].orderCount, 1);
  assert.equal(snapshot.purchaseProfiles[0].lifetimeValue, 200);
});

test('invalid order totals contribute zero value without removing purchase frequency', () => {
  const snapshot = buildAIManagerSnapshot(source([
    order('nan', 'buyer@example.com', 'guest', '2026-03-01T12:00:00.000Z', Number.NaN),
    order('negative', 'buyer@example.com', 'guest', '2026-03-02T12:00:00.000Z', -50),
  ])).customers;
  assert.equal(snapshot.purchaseProfiles[0].orderCount, 2);
  assert.equal(snapshot.purchaseProfiles[0].lifetimeValue, 0);
});

test('customer metrics calculate repeat counts, percentages, averages, lifetime value, and retention windows', () => {
  const metrics = buildCustomerMetrics(customerSnapshot([
    profile(['2026-01-15T12:00:00.000Z', '2026-03-10T12:00:00.000Z'], 500),
    profile(['2026-03-20T12:00:00.000Z'], 100),
    profile(['2026-02-15T12:00:00.000Z', '2026-02-20T12:00:00.000Z'], 300),
  ], 4), new Date('2026-03-31T12:00:00.000Z'));
  assert.equal(metrics.totalCustomers, 4);
  assert.equal(metrics.activePurchasingCustomers, 3);
  assert.equal(metrics.newCustomers, 1);
  assert.equal(metrics.returningCustomers, 2);
  assert.equal(Math.abs(metrics.repeatPurchaseRate - (200 / 3)) < 1e-10, true);
  assert.equal(metrics.averageOrdersPerCustomer, 5 / 3);
  assert.equal(metrics.averageCustomerLifetimeValue, 300);
  assert.equal(metrics.customersWithSinglePurchase, 1);
  assert.equal(metrics.retention.current.startDate, '2026-03-02');
  assert.equal(metrics.retention.current.endDate, '2026-03-31');
  assert.equal(metrics.retention.current.retentionRate, 50);
  assert.equal(metrics.retention.previous.startDate, '2026-01-31');
  assert.equal(metrics.retention.previous.endDate, '2026-03-01');
  assert.equal(metrics.retention.previous.retentionRate, 0);
  assert.equal(metrics.retention.trend, 'improving');
  assert.equal(metrics.health.status, 'healthy');
  assert.equal(Object.isFrozen(metrics), true);
});

test('customer health and insights provide factual critical and empty states', () => {
  const empty = buildCustomerMetrics(customerSnapshot([], 0), new Date('2026-03-31T12:00:00.000Z'));
  assert.equal(empty.hasUsableHistory, false);
  assert.equal(empty.health.status, 'critical');
  assert.deepEqual(analyzeCustomers(empty).insights.map((item) => item.code), ['customer-no-history']);

  const noRepeat = buildCustomerMetrics(customerSnapshot([profile(['2026-03-10T12:00:00.000Z'])]), new Date('2026-03-31T12:00:00.000Z'));
  assert.equal(noRepeat.health.status, 'critical');
  assert.equal(analyzeCustomers(noRepeat).insights.some((item) => item.message.includes('No repeat customers')), true);
  assert.throws(() => buildCustomerMetrics(customerSnapshot([]), new Date('invalid')), RangeError);
});
