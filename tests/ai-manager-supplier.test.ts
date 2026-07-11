import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSuppliers } from '../src/features/ai-manager/services/analyzeSuppliers';
import { buildSupplierMetrics } from '../src/features/ai-manager/services/buildSupplierMetrics';
import type { SupplierSnapshot, SupplierSnapshotSync } from '../src/features/ai-manager/types/supplier';

const AS_OF = new Date('2026-03-10T12:00:00.000Z');
const supplier = (id: string, isEnabled = true) => ({ id, name: `Supplier ${id}`, isEnabled, lastSync: null });
const sync = (supplierId: string, timestamp: string | null, status: SupplierSnapshotSync['status'], pendingReviews: number | null = null): SupplierSnapshotSync => ({ supplierId, supplierName: `Supplier ${supplierId}`, timestamp, status, pendingReviews });
const snapshot = (overrides: Partial<SupplierSnapshot> = {}): SupplierSnapshot => ({ suppliers: [], syncHistory: [], reviewQueue: [], pendingChanges: [], ...overrides });

test('supplier metrics report enabled and disabled suppliers separately', () => {
  const metrics = buildSupplierMetrics(snapshot({ suppliers: [supplier('a'), supplier('b', false)] }), AS_OF);
  assert.equal(metrics.totalSuppliers, 2);
  assert.equal(metrics.enabledSuppliers, 1);
  assert.equal(metrics.disabledSuppliers, 1);
  assert.equal(metrics.supplierHealth.length, 1);
  assert.equal(metrics.supplierHealth[0].status, 'unavailable');
});

test('supplier with zero syncs is unavailable rather than assigned fabricated health', () => {
  const metrics = buildSupplierMetrics(snapshot({ suppliers: [supplier('zero')] }), AS_OF);
  assert.equal(metrics.sync.totalSyncs, 0);
  assert.equal(metrics.sync.lastSuccessfulSync, null);
  assert.equal(metrics.supplierHealth[0].status, 'unavailable');
  assert.equal(metrics.attentionSuppliers.length, 1);
});

test('supplier with only failures is critical and has no last successful sync', () => {
  const metrics = buildSupplierMetrics(snapshot({
    suppliers: [supplier('failed')],
    syncHistory: [sync('failed', '2026-03-10T08:00:00.000Z', 'failed')],
  }), AS_OF);
  assert.equal(metrics.supplierHealth[0].status, 'critical');
  assert.equal(metrics.supplierHealth[0].lastSuccessfulSync, null);
  assert.equal(metrics.sync.successRate, 0);
  assert.equal(metrics.sync.failedSyncs, 1);
});

test('supplier with only recent successes and a small backlog is healthy', () => {
  const metrics = buildSupplierMetrics(snapshot({
    suppliers: [supplier('success')],
    syncHistory: [sync('success', '2026-03-09T12:00:00.000Z', 'success')],
    reviewQueue: [{ id: 'review-1', supplierId: 'success', supplierName: 'Supplier success', status: 'Pending' }],
  }), AS_OF);
  assert.equal(metrics.supplierHealth[0].status, 'healthy');
  assert.equal(metrics.sync.successRate, 100);
  assert.equal(metrics.sync.lastSuccessfulSync?.relative, '1 day ago');
  assert.equal(metrics.sync.lastSuccessfulSync?.absolute, '2026-03-09 12:00 UTC');
});

test('supplier health respects three-day and seven-day staleness boundaries', () => {
  const atThree = buildSupplierMetrics(snapshot({ suppliers: [supplier('three')], syncHistory: [sync('three', '2026-03-07T12:00:00.000Z', 'success')] }), AS_OF);
  const afterThree = buildSupplierMetrics(snapshot({ suppliers: [supplier('after-three')], syncHistory: [sync('after-three', '2026-03-07T11:59:59.000Z', 'success')] }), AS_OF);
  const atSeven = buildSupplierMetrics(snapshot({ suppliers: [supplier('seven')], syncHistory: [sync('seven', '2026-03-03T12:00:00.000Z', 'success')] }), AS_OF);
  const afterSeven = buildSupplierMetrics(snapshot({ suppliers: [supplier('after-seven')], syncHistory: [sync('after-seven', '2026-03-03T11:59:59.000Z', 'success')] }), AS_OF);
  assert.equal(atThree.supplierHealth[0].status, 'healthy');
  assert.equal(afterThree.supplierHealth[0].status, 'attention');
  assert.equal(atSeven.supplierHealth[0].status, 'attention');
  assert.equal(afterSeven.supplierHealth[0].status, 'critical');
});

test('queues stay separate and backlog trend uses only two factual history values', () => {
  const metrics = buildSupplierMetrics(snapshot({
    suppliers: [supplier('a')],
    reviewQueue: [{ id: 'r1', supplierId: 'a', supplierName: 'Supplier a', status: 'Pending' }, { id: 'r2', supplierId: 'a', supplierName: 'Supplier a', status: 'Approved' }],
    pendingChanges: [{ id: 'c1', reviewQueueItemId: 'r1', supplierId: 'a', status: 'Pending' }, { id: 'c2', reviewQueueItemId: '', supplierId: 'a', status: 'Pending' }],
    syncHistory: [sync('a', '2026-03-10T10:00:00.000Z', 'success', 8), sync('a', '2026-03-09T10:00:00.000Z', 'success', 5)],
  }), AS_OF);
  assert.equal(metrics.queues.pendingReviews, 1);
  assert.equal(metrics.queues.pendingChanges, 2);
  assert.equal(metrics.queues.approvalBacklog, 1);
  assert.equal(metrics.queues.backlogTrend.direction, 'increased');
  assert.equal(metrics.queues.backlogTrend.absoluteChange, 3);

  const unavailable = buildSupplierMetrics(snapshot({ suppliers: [supplier('a')], syncHistory: [sync('a', '2026-03-10T10:00:00.000Z', 'success', 4)] }), AS_OF);
  assert.equal(unavailable.queues.backlogTrend.direction, 'unavailable');
  assert.equal(unavailable.queues.backlogTrend.absoluteChange, null);
});

test('invalid sync dates are excluded and supplier analysis is immutable and deterministic', () => {
  const metrics = buildSupplierMetrics(snapshot({ suppliers: [supplier('a')], syncHistory: [sync('a', 'invalid', 'success')] }), AS_OF);
  const first = analyzeSuppliers(metrics);
  const second = analyzeSuppliers(metrics);
  assert.equal(metrics.sync.totalSyncs, 0);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => buildSupplierMetrics(snapshot(), new Date('invalid')), RangeError);
});
