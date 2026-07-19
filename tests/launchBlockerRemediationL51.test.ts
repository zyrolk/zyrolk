import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMMERCIAL_PRODUCT_FIELDS,
  containsCommercialProductFields,
  mergeProductCommercialData,
  PRODUCT_PRIVATE_COLLECTION,
  splitProductData,
} from '../src/services/products/productCommercialData';
import { buildSupplierQueueDecisionPlan } from '../src/services/supplierQueueDecisionPlan';
import {
  COD_CONFIRMATION_WINDOW_MS,
  nextCheckoutAbuseCounter,
  OFFLINE_CHECKOUT_PHONE_LIMIT,
} from '../functions/src/api/checkout/checkoutLogic';

test('public product projection removes every commercial and supplier-only field', () => {
  const source = {
    id: 'camera', name: 'Camera', price: 4500, stock: 5,
    supplierId: 'supplier-1', supplierItemCode: ' A9-001 ', costPrice: 2000,
    marketPrice: 5000, supplierPurchasePrice: 1800, supplierInternalNotes: 'private',
    supplierProfit: 2500, supplierMetadata: { source: 'private' },
  };
  const { publicData, commercialData } = splitProductData(source);
  assert.equal(containsCommercialProductFields(publicData), false);
  assert.equal(commercialData.supplierItemCodeNormalized, 'a9-001');
  assert.equal(commercialData.costPrice, 2000);
  assert.equal(publicData.name, 'Camera');
  const merged = mergeProductCommercialData(publicData as never, commercialData);
  assert.equal(merged.costPrice, 2000);
  for (const field of COMMERCIAL_PRODUCT_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(publicData, field), false, field);
  }
});

test('supplier approval atomically separates public catalogue and private commercial data', () => {
  const plan = buildSupplierQueueDecisionPlan({
    id: 'queue-1',
    productPayload: {
      id: 'camera', name: 'Camera', description: '', price: 4500, imageUrl: 'https://cdn.example/camera.jpg',
      category: 'electronics', rating: 0, reviewsCount: 0, stock: 5, specs: {},
      supplierId: 'supplier-1', supplierItemCode: 'A9-001', costPrice: 2000, marketPrice: 5000,
    },
  }, 'approved', { uid: 'admin', email: 'admin@example.com' }, 'timestamp', 'audit');
  const publicWrite = plan.sets.find((operation) => operation.collection === 'products');
  const privateWrite = plan.sets.find((operation) => operation.collection === PRODUCT_PRIVATE_COLLECTION);
  assert.ok(publicWrite);
  assert.equal(containsCommercialProductFields(publicWrite.data), false);
  assert.equal(publicWrite.removeCommercialProductFields, true);
  assert.equal(privateWrite?.data.costPrice, 2000);
  assert.equal(privateWrite?.data.supplierId, 'supplier-1');
});

test('Firestore rules block commercial product writes and all public private-data access', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  assert.match(rules, /function isPublicProductData\(data\)/);
  for (const field of ['costPrice', 'marketPrice', 'supplierItemCode', 'supplierPurchasePrice', 'supplierInternalNotes', 'supplierProfit']) {
    assert.match(rules, new RegExp(`['"]${field}['"]`));
  }
  assert.match(rules, /match \/products\/\{productId\}[\s\S]*allow create, update: if isAdmin\(\) && isPublicProductData/);
  assert.match(rules, /match \/product_private\/\{productId\}[\s\S]*allow read, write: if isAdmin\(\)/);
  assert.match(rules, /match \/checkout_abuse_limits\/\{docId\}[\s\S]*allow read, write: if false/);
});

test('distributed COD limiter rejects repeated attempts and resets after its window', () => {
  const now = Date.UTC(2026, 6, 19, 12);
  let counter = nextCheckoutAbuseCounter(null, OFFLINE_CHECKOUT_PHONE_LIMIT, now);
  assert.equal(counter.count, 1);
  counter = nextCheckoutAbuseCounter(counter, OFFLINE_CHECKOUT_PHONE_LIMIT, now + 1);
  counter = nextCheckoutAbuseCounter(counter, OFFLINE_CHECKOUT_PHONE_LIMIT, now + 2);
  assert.throws(
    () => nextCheckoutAbuseCounter(counter, OFFLINE_CHECKOUT_PHONE_LIMIT, now + 3),
    /Too many cash-on-delivery orders/,
  );
  const reset = nextCheckoutAbuseCounter(counter, OFFLINE_CHECKOUT_PHONE_LIMIT, counter.expiresAt.getTime() + 1);
  assert.equal(reset.count, 1);
  assert.ok(COD_CONFIRMATION_WINDOW_MS > 0);
});

test('offline reservations expire, restore stock, and commit only after admin confirmation', () => {
  const checkout = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  const orders = readFileSync('functions/src/api/routes/orders.ts', 'utf8');
  const expiry = readFileSync('functions/src/scheduled/paymentReservations.ts', 'utf8');
  assert.match(checkout, /CHECKOUT_ABUSE_COLLECTION/);
  assert.match(checkout, /stockReservationStatus: "reserved"/);
  assert.match(checkout, /COD_CONFIRMATION_WINDOW_MS/);
  assert.match(orders, /committingOfflineReservation/);
  assert.match(orders, /stockReservationStatus: "committed"/);
  assert.match(orders, /stockReservationStatus: "released"/);
  assert.match(expiry, /isOfflineConfirmationReservation/);
  assert.match(expiry, /cod_confirmation_expired/);
  assert.match(expiry, /transaction\.update\(update\.ref, \{ stock: update\.stock \}\)/);
});

test('supplier responses use allowlists and missing profiles fail closed', () => {
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  const requestProjection = portal.slice(portal.indexOf('const projectRequestPayload'), portal.indexOf('const projectRequest ='));
  assert.match(portal, /profileSnapshot\.exists[\s\S]*: "missing"/);
  assert.match(portal, /profileStatus \|\| "pending"/);
  assert.match(portal, /PRODUCT_PRIVATE_COLLECTION/);
  assert.match(portal, /sanitizePublicProductData/);
  assert.match(requestProjection, /projectProduct/);
  assert.doesNotMatch(requestProjection, /costPrice|marketPrice|supplierInternalNotes|supplierProfit/);
  assert.doesNotMatch(portal.slice(portal.indexOf('const projectRequest ='), portal.indexOf('const projectOrder')), /\? request\.productPayload : \{\}/);
});

test('runtime configuration is allowlist-first and App Check is secure by default', () => {
  const config = readFileSync('functions/src/api/config.ts', 'utf8');
  const environment = readFileSync('.env.example', 'utf8');
  assert.match(config, /DEFAULT_ALLOWED_ORIGINS/);
  assert.match(config, /corsAllowsAllOrigins: false/);
  assert.match(config, /REQUIRE_APP_CHECK !== "false"/);
  assert.doesNotMatch(config, /compatibility-wildcard/);
  assert.match(environment, /API_ALLOWED_ORIGINS="https:\/\/zyro\.lk,https:\/\/www\.zyro\.lk,https:\/\/zyrolk-e0164\.web\.app"/);
  assert.match(environment, /REQUIRE_APP_CHECK="true"/);
});

test('commercial-data migration is credential-gated, explicit, and verifies the result', () => {
  const migration = readFileSync('scripts/migrateProductCommercialData.ts', 'utf8');
  assert.match(migration, /process\.argv\.includes\('--apply'\)/);
  assert.match(migration, /PRODUCT_SECURITY_MIGRATION_CONFIRM/);
  assert.match(migration, /applicationDefault\(\)/);
  assert.match(migration, /FieldValue\.delete\(\)/);
  assert.match(migration, /unsafePublicProducts: 0/);
});
