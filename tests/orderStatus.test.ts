import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORDER_STATUSES,
  allowedOrderStatusTransitions,
  assertValidOrderStatusTransition,
  buildOrderStatusPlan,
  collectOrderStockQuantities,
  hasSupplierAssignment,
  hasSupplierFulfilmentStarted,
  requireCurrentProductStock,
} from '../functions/src/api/orders/orderStatusLogic';

test('cancellation aggregates stock restoration quantities exactly once', () => {
  const first = buildOrderStatusPlan('pending', 'cancelled', true, false, [
    { productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 4 },
  ]);
  assert.equal(first.shouldRestoreStock, true);
  assert.deepEqual(Array.from(first.quantities), [['p1', 3], ['p2', 4]]);

  const repeated = buildOrderStatusPlan('cancelled', 'cancelled', true, true, [{ productId: 'p1', quantity: 3 }]);
  assert.equal(repeated.shouldRestoreStock, false);
  assert.equal(repeated.quantities.size, 0);
});

test('cancelled orders cannot be returned to an active status', () => {
  assert.throws(() => buildOrderStatusPlan('cancelled', 'confirmed', true, true, []), /cannot be moved/);
});

test('order lifecycle permits only explicit forward transitions and cancellation branches', () => {
  assert.deepEqual(allowedOrderStatusTransitions('pending'), ['confirmed', 'cancelled']);
  assert.deepEqual(allowedOrderStatusTransitions('confirmed'), ['processing', 'cancelled']);
  assert.deepEqual(allowedOrderStatusTransitions('processing'), ['packed', 'shipped', 'cancelled']);
  assert.deepEqual(allowedOrderStatusTransitions('packed'), ['shipped', 'cancelled']);
  assert.deepEqual(allowedOrderStatusTransitions('shipped'), ['delivered']);
  assert.deepEqual(allowedOrderStatusTransitions('delivered'), []);
  assert.deepEqual(allowedOrderStatusTransitions('cancelled'), []);

  for (const current of ORDER_STATUSES) {
    assert.equal(assertValidOrderStatusTransition(current, current), current, `${current} should be idempotent`);
    for (const next of ORDER_STATUSES) {
      if (next === current || allowedOrderStatusTransitions(current).includes(next)) continue;
      assert.throws(() => assertValidOrderStatusTransition(current, next), /cannot be moved/);
    }
  }
});

test('legacy orders without a status start at pending but unknown statuses fail closed', () => {
  assert.equal(assertValidOrderStatusTransition(undefined, 'confirmed'), 'confirmed');
  assert.throws(() => assertValidOrderStatusTransition('unknown', 'confirmed'), /status is invalid/);
});

test('orders without a trusted stock deduction marker cannot add inventory', () => {
  const plan = buildOrderStatusPlan('pending', 'cancelled', undefined, false, [{ productId: 'p1', quantity: 5 }]);
  assert.equal(plan.shouldRestoreStock, false);
  assert.equal(plan.quantities.size, 0);
});

test('supplier fulfilment state fences cancellation and treats unknown active states safely', () => {
  assert.equal(hasSupplierFulfilmentStarted(undefined), false);
  assert.equal(hasSupplierFulfilmentStarted('pending'), false);
  assert.equal(hasSupplierFulfilmentStarted('processing'), true);
  assert.equal(hasSupplierFulfilmentStarted('packed'), true);
  assert.equal(hasSupplierFulfilmentStarted('shipped'), true);
  assert.equal(hasSupplierFulfilmentStarted('unexpected-state'), true);
  assert.equal(hasSupplierAssignment({ supplierId: 'supplier-a' }), true);
  assert.equal(hasSupplierAssignment({ supplierIds: ['supplier-a'] }), true);
  assert.equal(hasSupplierAssignment({}), false);
  assert.throws(
    () => buildOrderStatusPlan('confirmed', 'cancelled', true, false, [{ productId: 'p1', quantity: 1 }], 'processing'),
    /cannot be cancelled after supplier fulfilment has started/i,
  );
});

test('inventory reconciliation aggregates duplicate lines and rejects corrupt order data', () => {
  assert.deepEqual(Array.from(collectOrderStockQuantities([
    { productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 1 },
  ])), [['p1', 5], ['p2', 1]]);
  assert.throws(() => collectOrderStockQuantities([]), /inventory data is invalid/);
  assert.throws(() => collectOrderStockQuantities([{ productId: 'p1', quantity: 0 }]), /inventory data is invalid/);
  assert.throws(() => collectOrderStockQuantities([{ productId: '', quantity: 1 }]), /inventory data is invalid/);
});

test('inventory restoration fails closed for missing, fractional, negative or corrupt product stock', () => {
  assert.equal(requireCurrentProductStock(true, 4), 4);
  assert.throws(() => requireCurrentProductStock(false, 4), /could not be reconciled/);
  assert.throws(() => requireCurrentProductStock(true, 1.5), /could not be reconciled/);
  assert.throws(() => requireCurrentProductStock(true, -1), /could not be reconciled/);
  assert.throws(() => requireCurrentProductStock(true, 'invalid'), /could not be reconciled/);
});
