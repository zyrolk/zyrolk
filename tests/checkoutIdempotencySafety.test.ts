import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CheckoutError,
  requireCheckoutIdempotencyKey,
  resolveCheckoutIdempotency,
} from '../functions/src/api/checkout/checkoutLogic';
import {
  clearCheckoutIdempotencyKey,
  getCheckoutIdempotencyKey,
  type CheckoutIdempotencyStorage,
} from '../src/features/checkout/checkoutIdempotency';

class FakeStorage implements CheckoutIdempotencyStorage {
  value: string | null = null;
  readFailure = false;
  writeFailure = false;
  removeFailure = false;

  getItem(): string | null {
    if (this.readFailure) throw new Error('storage read denied');
    return this.value;
  }

  setItem(_key: string, value: string): void {
    if (this.writeFailure) throw new Error('storage write denied');
    this.value = value;
  }

  removeItem(): void {
    if (this.removeFailure) throw new Error('storage remove denied');
    this.value = null;
  }
}

test('sessionStorage unavailable keeps one key for the active checkout attempt', () => {
  clearCheckoutIdempotencyKey(null);
  const first = getCheckoutIdempotencyKey('attempt-without-storage', null);
  const retry = getCheckoutIdempotencyKey('attempt-without-storage', null);

  assert.equal(retry, first);
  assert.equal(getCheckoutIdempotencyKey('changed-request-before-resolution', null), first);
});

test('sessionStorage read and write exceptions still reuse the active key', () => {
  const readBlocked = new FakeStorage();
  readBlocked.readFailure = true;
  clearCheckoutIdempotencyKey(readBlocked);
  const readFailureKey = getCheckoutIdempotencyKey('read-failure-attempt', readBlocked);
  assert.equal(getCheckoutIdempotencyKey('read-failure-attempt', readBlocked), readFailureKey);

  const writeBlocked = new FakeStorage();
  writeBlocked.writeFailure = true;
  clearCheckoutIdempotencyKey(writeBlocked);
  const writeFailureKey = getCheckoutIdempotencyKey('write-failure-attempt', writeBlocked);
  assert.equal(getCheckoutIdempotencyKey('write-failure-attempt', writeBlocked), writeFailureKey);
});

test('a definitively completed attempt can be cleared before a new attempt gets a key', () => {
  const storage = new FakeStorage();
  clearCheckoutIdempotencyKey(storage);
  const first = getCheckoutIdempotencyKey('completed-attempt', storage);
  clearCheckoutIdempotencyKey(storage);
  const next = getCheckoutIdempotencyKey('completed-attempt', storage);

  assert.notEqual(next, first);
});

test('missing, empty, non-text, control-character and oversized keys are rejected', () => {
  for (const [header, body] of [
    [undefined, undefined],
    ['', '   '],
    [undefined, 123],
    [undefined, 'valid\nkey'],
    [undefined, 'x'.repeat(201)],
  ] as Array<[unknown, unknown]>) {
    assert.throws(
      () => requireCheckoutIdempotencyKey(header, body),
      (error) => error instanceof CheckoutError && error.statusCode === 400,
    );
  }

  assert.equal(requireCheckoutIdempotencyKey(' valid-checkout-key ', undefined), 'valid-checkout-key');
});

test('a lost response can reconcile to the original order without a second mutation', () => {
  const order = { id: 'order-1', orderNumber: 'ZY100001' };
  const decision = resolveCheckoutIdempotency({
    requestHash: 'request-hash',
    status: 'succeeded',
    order,
  }, 'request-hash');

  assert.deepEqual(decision, { action: 'return-order', order });
});

test('checkout route requires the key before its transaction and persists the replay record transactionally', () => {
  const route = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  const drawer = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
  const validationOffset = route.indexOf('requireCheckoutIdempotencyKey(');
  const transactionOffset = route.indexOf('adminDb.runTransaction');

  assert.ok(validationOffset >= 0);
  assert.ok(transactionOffset > validationOffset);
  assert.match(route, /transaction\.get\(idempotencyRef\)/u);
  assert.match(route, /transaction\.set\(idempotencyRef,/u);
  assert.match(route, /resolveCheckoutCustomerUid\(req\.header\("Authorization"\)\)/u);
  assert.match(drawer, /const idempotencyKey = getCheckoutIdempotencyKey\(checkoutSignature\);/u);
  assert.match(drawer, /isSubmittingRef\.current \|\| isCartReconciliationPending/u);
  assert.match(drawer, /isSubmittingRef\.current = true;/u);
  assert.match(drawer, /isSubmittingRef\.current = false;/u);
});
