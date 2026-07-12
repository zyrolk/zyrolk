import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrderStatusPlan } from '../functions/src/api/orders/orderStatusLogic';

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

test('orders without a trusted stock deduction marker cannot add inventory', () => {
  const plan = buildOrderStatusPlan('pending', 'cancelled', undefined, false, [{ productId: 'p1', quantity: 5 }]);
  assert.equal(plan.shouldRestoreStock, false);
  assert.equal(plan.quantities.size, 0);
});
