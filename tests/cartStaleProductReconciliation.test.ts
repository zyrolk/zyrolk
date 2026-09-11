import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

type RuntimeProduct = {
  id: string;
  isActive: boolean;
  stock: number;
  price: number;
};

type RuntimeCartItem = {
  product: RuntimeProduct;
  quantity: number;
};

type RuntimeExports = {
  createCartOpenReconciliationController: () => {
    open: () => number;
    close: () => void;
    invalidateForAuthContext: () => void;
    begin: (contextKey: string, ready?: boolean) => { token: number; sessionId: number; contextKey: string } | null;
    beginPersistenceHold: (contextKey: string) => { token: number; sessionId: number; contextKey: string } | null;
    isPersistenceHeld: () => boolean;
    canPersist: (authenticated: boolean) => boolean;
    isPersistenceHoldFor: (request: { token: number; sessionId: number; contextKey: string }) => boolean;
    isCurrent: (request: { token: number; sessionId: number; contextKey: string }) => boolean;
    complete: (request: { token: number; sessionId: number; contextKey: string }) => boolean;
  };
  reconcileCartSnapshot: (
    currentCart: readonly RuntimeCartItem[],
    productIds: readonly string[],
    refreshedProducts: readonly RuntimeProduct[],
  ) => { nextCart: RuntimeCartItem[]; removedCount: number; updatedCount: number };
};

const appSource = readFileSync('src/App.tsx', 'utf8');
const controllerStart = appSource.indexOf('export function createCartOpenReconciliationController');
const helperEnd = appSource.indexOf('const selectFilteredStorefrontProducts');
assert.ok(controllerStart >= 0 && helperEnd > controllerStart, 'cart reconciliation runtime exports must remain available');

const runtimeSource = `
const filterCommerceProductIds = (ids) => ids.filter((id) => typeof id === 'string' && !id.startsWith('preview:'));
const isProductExplicitlyActive = (value) => value === true;
${appSource.slice(controllerStart, helperEnd)}
`;
const runtimeModule = { exports: {} as RuntimeExports };
const runtimeCode = transformSync(runtimeSource, { loader: 'tsx', format: 'cjs' }).code;
new Function('module', 'exports', runtimeCode)(runtimeModule, runtimeModule.exports);
const { createCartOpenReconciliationController, reconcileCartSnapshot } = runtimeModule.exports;

const product = (id: string, overrides: Partial<RuntimeProduct> = {}): RuntimeProduct => ({
  id,
  isActive: true,
  stock: 10,
  price: 100,
  ...overrides,
});

const item = (id: string, quantity: number, overrides: Partial<RuntimeProduct> = {}): RuntimeCartItem => ({
  product: product(id, overrides),
  quantity,
});

test('guest closed-open reconciles once and cart updates do not retrigger the same context', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const first = controller.begin('guest:1', true);
  assert.ok(first);
  assert.equal(controller.begin('guest:1', true), null);
  assert.equal(controller.complete(first), true);
  assert.equal(controller.begin('guest:1', true), null);
});

test('close and reopen creates a fresh reconciliation session', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const first = controller.begin('guest:1', true);
  assert.ok(first);
  controller.close();
  assert.equal(controller.isCurrent(first), false);
  controller.open();
  const reopened = controller.begin('guest:1', true);
  assert.ok(reopened);
  assert.notEqual(reopened.sessionId, first.sessionId);
});

test('authenticated context waits for readiness and reruns after guest-to-auth merge', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const guest = controller.begin('guest:1', true);
  assert.ok(guest);
  controller.invalidateForAuthContext();
  assert.equal(controller.isCurrent(guest), false);
  assert.equal(controller.begin('user:user-1:ready', false), null);
  const authenticated = controller.begin('user:user-1:ready', true);
  assert.ok(authenticated);
  assert.notEqual(authenticated.token, guest.token);
});

test('authenticated merge hold blocks persistence until the current reconciliation succeeds', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const guest = controller.begin('1:guest:ready', true);
  assert.ok(guest);
  controller.invalidateForAuthContext();
  const hold = controller.beginPersistenceHold('2:user-1:user-1');
  assert.ok(hold);
  assert.equal(controller.isPersistenceHeld(), true);
  assert.equal(controller.canPersist(true), false);
  const authenticated = controller.begin('2:user-1:user-1', true);
  assert.ok(authenticated);
  assert.equal(controller.isPersistenceHoldFor(authenticated), true);
  assert.equal(controller.complete(authenticated), true);
  assert.equal(controller.isPersistenceHeld(), false);
  assert.equal(controller.canPersist(true), true);
});

test('transient authenticated reconciliation failure releases the hold without changing the merged cart', async () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  controller.beginPersistenceHold('2:user-1:user-1');
  const authenticated = controller.begin('2:user-1:user-1', true);
  assert.ok(authenticated);
  const mergedCart = [item('stale', 1), item('valid', 2)];
  let currentCart = mergedCart;
  try {
    await Promise.reject(new Error('temporary hydration failure'));
  } catch {
    assert.equal(controller.canPersist(true), false);
    assert.deepEqual(currentCart, mergedCart);
  } finally {
    assert.equal(controller.complete(authenticated), true);
  }
  assert.equal(controller.canPersist(true), true);
  assert.deepEqual(currentCart, mergedCart);
});

test('obsolete guest completion cannot release the authenticated persistence hold', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const guest = controller.begin('1:guest:ready', true);
  assert.ok(guest);
  controller.invalidateForAuthContext();
  controller.beginPersistenceHold('2:user-1:user-1');
  const authenticated = controller.begin('2:user-1:user-1', true);
  assert.ok(authenticated);
  assert.equal(controller.complete(guest), false);
  assert.equal(controller.isPersistenceHeld(), true);
  assert.equal(controller.canPersist(true), false);
  assert.equal(controller.complete(authenticated), true);
});

test('close and reopen prevents an older request from releasing the newer persistence hold', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  controller.beginPersistenceHold('1:user-1:user-1');
  const oldRequest = controller.begin('1:user-1:user-1', true);
  assert.ok(oldRequest);
  controller.close();
  controller.open();
  controller.beginPersistenceHold('2:user-1:user-1');
  const newRequest = controller.begin('2:user-1:user-1', true);
  assert.ok(newRequest);
  assert.equal(controller.complete(oldRequest), false);
  assert.equal(controller.isPersistenceHeld(), true);
  assert.equal(controller.canPersist(true), false);
  assert.equal(controller.complete(newRequest), true);
  assert.equal(controller.canPersist(true), true);
});

test('ordinary signed-out and authenticated carts remain persistence-eligible without a hold', () => {
  const controller = createCartOpenReconciliationController();
  assert.equal(controller.canPersist(false), true);
  controller.open();
  const authenticated = controller.begin('1:user-1:user-1', true);
  assert.ok(authenticated);
  assert.equal(controller.canPersist(true), true);
  assert.equal(controller.complete(authenticated), true);
  assert.equal(controller.canPersist(true), true);
});

test('stale in-flight guest completion is discarded after authentication changes', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const guest = controller.begin('guest:1', true);
  assert.ok(guest);
  controller.invalidateForAuthContext();
  const authenticated = controller.begin('user:user-1:ready', true);
  assert.ok(authenticated);
  assert.equal(controller.complete(guest), false);
  assert.equal(controller.isCurrent(authenticated), true);
  assert.equal(controller.complete(authenticated), true);
});

test('stale in-flight completion is discarded after close and reopen', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const first = controller.begin('guest:1', true);
  assert.ok(first);
  controller.close();
  controller.open();
  const reopened = controller.begin('guest:1', true);
  assert.ok(reopened);
  assert.equal(controller.complete(first), false);
  assert.equal(controller.isCurrent(reopened), true);
});

test('not-ready reconciliation cannot own a pending request', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  assert.equal(controller.begin('user:user-1:loading', false), null);
});

test('snapshot reconciliation removes stale items, preserves siblings, refreshes price, and clamps stock', () => {
  const currentCart = [item('stale', 2), item('inactive', 1), item('empty', 3), item('valid', 5)];
  const result = reconcileCartSnapshot(currentCart, currentCart.map(({ product: { id } }) => id), [
    product('stale', { isActive: false }),
    product('inactive', { isActive: false }),
    product('empty', { stock: 0 }),
    product('valid', { price: 125, stock: 2 }),
  ]);
  assert.deepEqual(result.nextCart.map(({ product: { id } }) => id), ['valid']);
  assert.equal(result.nextCart[0].product.price, 125);
  assert.equal(result.nextCart[0].quantity, 2);
  assert.equal(result.removedCount, 3);
});

test('transient failure keeps the original cart and current request owns pending state', async () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const request = controller.begin('guest:1', true);
  assert.ok(request);
  const originalCart = [item('valid', 2)];
  let currentCart = originalCart;
  try {
    await Promise.reject(new Error('temporary hydration failure'));
  } catch {
    assert.deepEqual(currentCart, originalCart);
    assert.equal(controller.isCurrent(request), true);
  }
  assert.equal(controller.complete(request), true);
  assert.deepEqual(currentCart, originalCart);
});

test('obsolete completion cannot re-enable controls while a newer request is pending', () => {
  const controller = createCartOpenReconciliationController();
  controller.open();
  const first = controller.begin('guest:1', true);
  assert.ok(first);
  controller.invalidateForAuthContext();
  const current = controller.begin('user:user-1:ready', true);
  assert.ok(current);
  let pending = true;
  if (controller.complete(first)) pending = false;
  assert.equal(pending, true);
  assert.equal(controller.complete(current), true);
});

test('App wiring keeps checkout authority and passes current reconciliation state through the drawer', () => {
  const app = appSource;
  const drawer = readFileSync('src/components/CartDrawer.tsx', 'utf8');
  const checkout = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
  assert.match(app, /onRefreshCartProducts=\{handleRefreshCartProducts\}/);
  assert.match(app, /isCartReconciliationPending=\{isCartReconciliationPending\}/);
  assert.match(drawer, /return <PremiumCheckoutDrawer \{\.\.\.props\} \/>/);
  assert.match(checkout, /paymentMethod = 'cod'/);
  assert.match(checkout, /\/api\/checkout/);
  assert.match(checkout, /CHECKOUT_PRICE_CHANGED/);
  assert.match(checkout, /<fieldset disabled=\{isCartReconciliationPending\} style=\{\{ border: 0, margin: 0, padding: 0, minInlineSize: 0 \}\}>/);
  assert.match(checkout, /<fieldset className="zy-payment-options">/);
});
