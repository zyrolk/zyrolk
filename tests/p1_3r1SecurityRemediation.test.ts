import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getBestEffortNetworkRateLimitKey } from '../functions/src/api/checkout/checkoutLogic';

const appSource = readFileSync('functions/src/api/app.ts', 'utf8');
const supplierAuthSource = readFileSync('functions/src/api/middleware/supplierHubAdminAuth.ts', 'utf8');
const supplierRoutesSource = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
const checkoutSource = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');

test('untrusted supplier App Check rejection has no persistent alert dependency', () => {
  assert.doesNotMatch(appSource, /recordSupplierOperationalAlertSafely/u);
  assert.match(appSource, /Supplier API App Check rejected/u);
  assert.match(appSource, /App verification is required/u);
  assert.match(appSource, /App verification failed/u);
});

test('Supplier Hub authentication rejection has no persistent alert dependency', () => {
  assert.doesNotMatch(supplierAuthSource, /recordSupplierOperationalAlertSafely/u);
  assert.match(supplierAuthSource, /reason: "missing_bearer_token"/u);
  assert.match(supplierAuthSource, /reason: "admin_claim_required"/u);
  assert.match(supplierAuthSource, /Invalid, expired, or revoked authentication token/u);
  assert.match(supplierAuthSource, /Supplier Hub API authentication rejected/u);
});

test('verified supplier operational failures retain the persistent alert engine', () => {
  assert.match(supplierRoutesSource, /recordSupplierOperationalAlertSafely/u);
  assert.match(supplierRoutesSource, /category: "supplier_connection_failure"/u);
});

test('checkout replay protection remains App Check consume-enabled and fail-closed', () => {
  assert.match(appSource, /adminAppCheck\.verifyToken\(token, \{ consume: true \}\)/u);
  assert.match(appSource, /Replayed App Check token rejected/u);
  assert.match(checkoutSource, /getBestEffortNetworkRateLimitKey\(req\.header\("x-forwarded-for"\), req\.ip\)/u);
});

test('current network rate-limit helper behavior is characterized without treating req.ip as trusted identity', () => {
  assert.equal(getBestEffortNetworkRateLimitKey('198.51.100.10, 10.0.0.1', 'socket-peer'), '198.51.100.10');
  assert.equal(getBestEffortNetworkRateLimitKey(undefined, 'socket-peer'), 'socket-peer');
  assert.equal(getBestEffortNetworkRateLimitKey(undefined, undefined), 'unknown');
  assert.doesNotMatch(appSource, /trust proxy/u);
});
