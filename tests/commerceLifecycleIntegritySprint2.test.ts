import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  projectOrderEmailDelivery,
  orderEmailRetryDelay,
  safeOrderEmailFailure,
} from '../functions/src/api/orders/orderNotificationLogic';
import {
  requiresUnsupportedVariantSelection,
  validateSupplierProductForApproval,
} from '../functions/src/api/suppliers/supplierProductMapping';

const validProduct = {
  name: 'Product', imageUrl: 'https://cdn.example.com/product.jpg', price: 1000, stock: 5,
  isActive: true, category: 'electronics', subcategory: 'phones', brand: 'brand-1', specs: {},
};
const categories = [{ id: 'electronics', name: 'Electronics', subcategories: [{ id: 'phones', name: 'Phones' }] }];
const brands = [{ id: 'brand-1', name: 'Brand' }];

test('Sprint 2 blocks only products that require unsupported variant selection', () => {
  assert.equal(requiresUnsupportedVariantSelection(validProduct), false);
  assert.equal(requiresUnsupportedVariantSelection({ ...validProduct, variants: [{ sku: 'one' }], options: { Color: ['Black'] } }), false);
  assert.equal(requiresUnsupportedVariantSelection({ ...validProduct, variants: [{ sku: 'one' }, { sku: 'two' }] }), true);
  assert.equal(requiresUnsupportedVariantSelection({ ...validProduct, options: { Color: ['Black', 'Blue'] } }), true);
  assert.equal(requiresUnsupportedVariantSelection({ ...validProduct, variantSelectionRequired: true }), true);

  const errors = validateSupplierProductForApproval({
    ...validProduct,
    variants: [{ sku: 'black' }, { sku: 'blue' }],
    options: { Color: ['Black', 'Blue'] },
  }, categories, brands);
  assert.deepEqual(errors.filter((error) => error.field === 'variants').map((error) => error.code), [
    'unsupported_variant_selection',
  ]);
  assert.deepEqual(validateSupplierProductForApproval(validProduct, categories, brands), []);
});

test('Sprint 2 email delivery projection is bounded, observable and retryable', () => {
  assert.deepEqual(projectOrderEmailDelivery('SUCCESS', 1, 1_000), { status: 'delivered', shouldRetry: false });
  assert.deepEqual(projectOrderEmailDelivery('PROCESSING', 1, 1_000), { status: 'delivering', shouldRetry: false });
  assert.deepEqual(projectOrderEmailDelivery('ERROR', 1, 1_000), {
    status: 'retry_pending', shouldRetry: true, nextRetryAtMillis: 1_000 + orderEmailRetryDelay(1),
  });
  assert.deepEqual(projectOrderEmailDelivery('ERROR', 3, 1_000), { status: 'failed', shouldRetry: false });
  assert.equal(orderEmailRetryDelay(2), orderEmailRetryDelay(1) * 2);
  assert.equal(safeOrderEmailFailure({ message: ' provider\u0000 failed ' }), 'provider failed');
});

test('Sprint 2 email trigger records delivery status and scheduled bounded retries', () => {
  const trigger = readFileSync('functions/src/triggers/orderNotifications.ts', 'utf8');
  const retry = readFileSync('functions/src/scheduled/orderNotificationRetries.ts', 'utf8');
  const index = readFileSync('functions/src/index.ts', 'utf8');
  const indexes = readFileSync('firestore.indexes.json', 'utf8');
  assert.match(trigger, /trackOrderNotificationDelivery/);
  assert.match(trigger, /currentMailId/);
  assert.match(trigger, /retry_pending/);
  assert.match(retry, /where\("status", "==", "retry_pending"\)/);
  assert.match(retry, /orderBy\("nextRetryAt", "asc"\)/);
  assert.match(retry, /attemptCount >= maxAttempts/);
  assert.match(index, /retryOrderNotifications/);
  assert.match(indexes, /"collectionGroup": "notification_outbox"/);
});

test('Sprint 2 checkout remains live-price, atomic, idempotent and identity aware', () => {
  const checkout = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  const client = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
  assert.match(checkout, /runTransaction/);
  assert.match(checkout, /const truePrice = Number\(pData\.price\)/);
  assert.match(checkout, /Number\.isInteger\(currentStock\)/);
  assert.match(checkout, /resolveCouponDiscount/);
  assert.match(checkout, /resolveCheckoutCustomerUid/);
  assert.match(checkout, /customer identity does not match/);
  assert.match(client, /if \(!cartItems\.length \|\| isSubmitting\) return/);
  assert.match(client, /'Idempotency-Key': idempotencyKey/);
  assert.match(client, /user \? await user\.getIdToken\(\) : ''/);
});

test('Sprint 2 order mutations use the server-authoritative transition and restoration plan', () => {
  const orders = readFileSync('functions/src/api/routes/orders.ts', 'utf8');
  const preview = readFileSync('server.ts', 'utf8');
  const admin = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  assert.match(orders, /buildOrderStatusPlan/);
  assert.match(orders, /requireAdminAuth/);
  assert.match(orders, /requireCurrentProductStock/);
  assert.match(preview, /buildOrderStatusPlan/);
  assert.match(admin, /<option value="processing">Processing<\/option>/);
});

test('Sprint 2 supplier stock approval remains reservation-aware', () => {
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const offer = readFileSync('functions/src/api/suppliers/supplierOfferEngine.ts', 'utf8');
  const expiry = readFileSync('functions/src/scheduled/paymentReservations.ts', 'utf8');
  assert.match(approval, /reconcileSupplierApprovalStock/);
  assert.match(offer, /reconcileSupplierApprovalStock/);
  assert.match(expiry, /collectOrderStockQuantities\(order\.items\)/);
  assert.match(expiry, /Promise\.allSettled/);
});
