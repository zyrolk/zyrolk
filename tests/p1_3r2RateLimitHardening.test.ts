import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getAuthenticatedCheckoutRateLimitKey,
  getBestEffortNetworkRateLimitKey,
  getGuestCheckoutRateLimitKeys,
} from '../functions/src/api/checkout/checkoutLogic';
import {
  CONTACT_RATE_LIMIT_MAX_REQUESTS,
  nextContactRateLimitState,
} from '../functions/src/api/contact/contactInquiries';
import { hashGuestRecoveryToken, validateGuestRecoveryToken } from '../functions/src/api/orders/guestOrderRecovery';

const checkoutSource = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
const contactSource = readFileSync('functions/src/api/routes/contact.ts', 'utf8');
const ordersSource = readFileSync('functions/src/api/routes/orders.ts', 'utf8');
const paymentsSource = readFileSync('functions/src/api/routes/payments.ts', 'utf8');
const appSource = readFileSync('functions/src/api/app.ts', 'utf8');

test('authenticated checkout uses a UID-derived authoritative bucket independent of XFF', () => {
  const key = getAuthenticatedCheckoutRateLimitKey('uid-123');
  assert.match(key, /^checkout-user:[a-f0-9]{64}$/u);
  assert.equal(getAuthenticatedCheckoutRateLimitKey('uid-123'), key);
  assert.notEqual(getAuthenticatedCheckoutRateLimitKey('uid-456'), key);
  assert.doesNotMatch(key, /uid-123/u);

  const authResolution = checkoutSource.indexOf('customerUid = await resolveCheckoutCustomerUid');
  const userLimiter = checkoutSource.indexOf('getAuthenticatedCheckoutRateLimitKey(customerUid)');
  assert.ok(authResolution >= 0 && userLimiter > authResolution);
});

test('invalid checkout bearer tokens cannot downgrade into guest rate limiting', () => {
  assert.match(checkoutSource, /catch \{\s*throw new CheckoutError\("Invalid or expired authentication token", 401\);/su);
  assert.doesNotMatch(checkoutSource, /catch \{\s*return "guest"/su);
});

test('guest checkout uses required phone and optional supplied email without exposing raw values', () => {
  const keys = getGuestCheckoutRateLimitKeys('+94 77 123 4567', ' Customer@Example.COM ');
  assert.equal(keys.length, 2);
  assert.match(keys[0], /^guest-checkout-phone:[a-f0-9]{64}$/u);
  assert.match(keys[1], /^guest-checkout-email:[a-f0-9]{64}$/u);
  assert.doesNotMatch(keys.join('|'), /94771234567|customer@example\.com/iu);
  assert.deepEqual(getGuestCheckoutRateLimitKeys('+94771234567', 'customer@example.com'), keys);
  assert.deepEqual(getGuestCheckoutRateLimitKeys('+94771234567', 'guest@zyro.lk'), [keys[0]]);
  assert.match(checkoutSource, /getGuestCheckoutRateLimitKeys\(customerPhone, customerEmail\)/u);
});

test('checkout retains the existing network bucket only as a secondary best-effort guard', () => {
  assert.match(checkoutSource, /secondary, best-effort/u);
  assert.match(checkoutSource, /getBestEffortNetworkRateLimitKey\(req\.header\("x-forwarded-for"\), req\.ip\)/u);
  assert.match(checkoutSource, /offline-network:/u);
  assert.match(checkoutSource, /offline-phone:/u);
  assert.match(checkoutSource, /offline-user:\$\{customerUid\}/u);
});

test('contact phone protection is authoritative for persistent writes while network remains secondary', () => {
  const phoneState = contactSource.indexOf('const phoneState = nextContactRateLimitState');
  const networkState = contactSource.indexOf('const networkState = nextContactRateLimitState');
  assert.ok(phoneState >= 0 && networkState > phoneState);
  assert.match(contactSource, /normalized phone bucket is the authoritative persistent-write/u);
  assert.match(contactSource, /contactRateLimitDocumentId\("phone"/u);
  assert.match(contactSource, /contactRateLimitDocumentId\("network"/u);
});

test('rotating XFF cannot bypass the same normalized contact phone bucket', () => {
  const now = Date.parse('2026-10-07T00:00:00.000Z');
  let phoneState = null;
  for (let attempt = 0; attempt < CONTACT_RATE_LIMIT_MAX_REQUESTS; attempt += 1) {
    phoneState = nextContactRateLimitState(phoneState, now + attempt);
  }
  assert.throws(
    () => nextContactRateLimitState(phoneState, now + CONTACT_RATE_LIMIT_MAX_REQUESTS),
    /Too many enquiries/u,
  );
  assert.match(contactSource, /contactRateLimitDocumentId\("phone", inquiry\.phone\.replace/u);
});

test('guest tracking validates and hashes the recovery credential before the order lookup', () => {
  const token = Buffer.alloc(32, 7).toString('base64url');
  const validated = validateGuestRecoveryToken(token);
  const digest = hashGuestRecoveryToken(validated);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(digest, new RegExp(token, 'u'));

  const validation = ordersSource.indexOf('const recoveryToken = validateGuestRecoveryToken');
  const limiter = ordersSource.indexOf('guest-track-token:${hashGuestRecoveryToken(recoveryToken)}');
  const lookup = ordersSource.indexOf('lookupGuestOrderByRecoveryToken(adminDb, recoveryToken)');
  assert.ok(validation >= 0 && limiter > validation && lookup > limiter);
  assert.match(ordersSource, /getBestEffortNetworkRateLimitKey/iu);
});

test('coupon remains protected by App Check and is explicitly unresolved for anonymous identity', () => {
  assert.match(appSource, /adminAppCheck\.verifyToken\(token\)/u);
  assert.match(checkoutSource, /app\.post\("\/api\/checkout\/coupon"/u);
  assert.match(checkoutSource, /getBestEffortNetworkRateLimitKey/iu);
  const couponRoute = checkoutSource.slice(
    checkoutSource.indexOf('app.post("/api/checkout/coupon"'),
    checkoutSource.indexOf('app.all("/api/checkout"'),
  );
  assert.doesNotMatch(couponRoute, /getAuthenticatedCheckoutRateLimitKey/u);
});

test('PayHere remains unregistered while its future source uses the secondary network helper', () => {
  assert.match(paymentsSource, /getBestEffortNetworkRateLimitKey/iu);
  assert.doesNotMatch(appSource, /registerPaymentRoutes\(/u);
});
