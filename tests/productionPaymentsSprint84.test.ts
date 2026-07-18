import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateCheckoutDetails } from '../functions/src/api/checkout/checkoutLogic';
import {
  PaymentError,
  amountsMatch,
  appendPaymentTimeline,
  buildPayHerePaymentSession,
  createGuestPaymentAccessToken,
  createPayHereCheckoutHash,
  createPaymentTimelineEvent,
  formatPayHereAmount,
  loadPayHereConfig,
  mapPayHereStatus,
  parsePayHereNotification,
  verifyGuestPaymentAccessToken,
  verifyPayHereNotification,
  type PayHereConfig,
} from '../functions/src/api/payments/payhereLogic';
import { getPaymentReturnContext, paymentStatusLabel } from '../src/features/checkout/payhere';

const config: PayHereConfig = {
  mode: 'sandbox',
  merchantId: '1211149',
  merchantSecret: 'sandbox-secret',
  publicSiteUrl: 'https://zyro.lk',
};

const md5Upper = (value: string) => createHash('md5').update(value, 'utf8').digest('hex').toUpperCase();

test('PayHere checkout hashes are server-derived from the trusted amount and merchant secret', () => {
  const expected = md5Upper(`${config.merchantId}order-1-14250.00LKR${md5Upper(config.merchantSecret)}`);
  assert.equal(createPayHereCheckoutHash(config, 'order-1-1', 4250, 'LKR'), expected);
  assert.equal(formatPayHereAmount(4250), '4250.00');
  assert.throws(() => formatPayHereAmount(0), PaymentError);
});

test('PayHere notification verification rejects tampering and accepts the official signature shape', () => {
  const notification = parsePayHereNotification({
    merchant_id: config.merchantId,
    order_id: 'order-1-1',
    payment_id: '320025021508',
    payhere_amount: '4250.00',
    payhere_currency: 'LKR',
    status_code: '2',
    md5sig: md5Upper(`${config.merchantId}order-1-14250.00LKR2${md5Upper(config.merchantSecret)}`),
    method: 'VISA',
    status_message: 'Success',
    card_no: '************1234',
  });
  assert.equal(verifyPayHereNotification(config, notification), true);
  assert.equal(verifyPayHereNotification(config, { ...notification, amount: '4251.00' }), false);
  assert.equal(amountsMatch(4250, notification.amount), true);
  assert.equal(amountsMatch(4250, '4250.01'), false);
});

test('PayHere status mapping covers success, pending, failure, cancellation and chargeback', () => {
  assert.equal(mapPayHereStatus('2'), 'paid');
  assert.equal(mapPayHereStatus('0'), 'pending');
  assert.equal(mapPayHereStatus('-1'), 'cancelled');
  assert.equal(mapPayHereStatus('-2'), 'failed');
  assert.equal(mapPayHereStatus('-3'), 'chargedback');
  assert.throws(() => mapPayHereStatus('99'), /Unsupported/);
  assert.throws(() => parsePayHereNotification({ status_code: '2' }), /Incomplete/);
});

test('PayHere configuration keeps sandbox and live credentials separated and requires HTTPS live URLs', () => {
  assert.equal(loadPayHereConfig({}, ''), null);
  assert.equal(loadPayHereConfig({ PAYHERE_MERCHANT_ID: config.merchantId, PAYHERE_MODE: 'sandbox', PUBLIC_SITE_URL: 'http://localhost:3000' }, config.merchantSecret)?.mode, 'sandbox');
  assert.throws(
    () => loadPayHereConfig({ PAYHERE_MERCHANT_ID: config.merchantId, PAYHERE_MODE: 'live', PUBLIC_SITE_URL: 'http://zyro.lk' }, config.merchantSecret),
    /requires an HTTPS/,
  );
  assert.throws(() => loadPayHereConfig({ PAYHERE_MERCHANT_ID: config.merchantId }, ''), /incomplete/);
});

test('PayHere sessions use approved gateway hosts, signed totals and server notification routes', () => {
  const session = buildPayHerePaymentSession(config, {
    id: 'firestore-order-id',
    gatewayOrderId: 'firestore-order-id-1',
    totalPrice: 4250,
    customerName: 'Nimali Perera',
    customerEmail: 'nimali@example.com',
    customerPhone: '0771234567',
    customerAddress: '10 Main Street',
    city: 'Colombo',
    orderNumber: 'ZY100084',
  });
  assert.equal(session.actionUrl, 'https://sandbox.payhere.lk/pay/checkout');
  assert.equal(session.fields.amount, '4250.00');
  assert.equal(session.fields.notify_url, 'https://zyro.lk/api/payments/payhere/notify');
  assert.match(session.fields.return_url, /^https:\/\/zyro\.lk\/\?payment=return/);
  assert.equal(session.fields.hash, createPayHereCheckoutHash(config, 'firestore-order-id-1', 4250));
});

test('guest payment access uses timing-safe signed tokens and return parsing fails closed', () => {
  const token = createGuestPaymentAccessToken(config, 'order-1');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(verifyGuestPaymentAccessToken(config, 'order-1', token), true);
  assert.equal(verifyGuestPaymentAccessToken(config, 'order-2', token), false);
  assert.deepEqual(getPaymentReturnContext(`?payment=return&order=order-1&access=${token}`), {
    outcome: 'return', orderId: 'order-1', accessToken: token,
  });
  assert.equal(getPaymentReturnContext('?payment=return&order=order-1'), null);
  assert.equal(paymentStatusLabel('paid'), 'Payment verified');
});

test('payment timeline history is factual, bounded and immutable', () => {
  const original = [createPaymentTimelineEvent('awaiting_payment', 'Payment started', 'checkout', new Date('2026-07-18T00:00:00Z'))];
  const next = appendPaymentTimeline(original, createPaymentTimelineEvent('paid', 'Payment verified', 'payhere', new Date('2026-07-18T00:01:00Z')));
  assert.equal(original.length, 1);
  assert.deepEqual(next.map(entry => entry.status), ['awaiting_payment', 'paid']);
  const bounded = Array.from({ length: 30 }, (_, index) => ({ id: String(index) }));
  assert.equal(appendPaymentTimeline(bounded, { id: 'latest' }).length, 20);
});

test('PayHere checkout requires a real customer email while COD remains backward compatible', () => {
  const base = {
    customerName: 'Nimali Perera', customerPhone: '0771234567', customerAddress: '10 Main Street', district: 'Colombo',
  };
  assert.doesNotThrow(() => validateCheckoutDetails({ ...base, paymentMethod: 'cod' }));
  assert.throws(() => validateCheckoutDetails({ ...base, paymentMethod: 'payhere' }), /email is required/i);
  assert.throws(() => validateCheckoutDetails({ ...base, customerEmail: 'guest@zyro.lk', paymentMethod: 'payhere' }), /customer email is required/i);
  assert.doesNotThrow(() => validateCheckoutDetails({ ...base, customerEmail: 'nimali@example.com', paymentMethod: 'payhere' }));
});

test('inventory reservation, retry and restoration remain atomic and idempotent', () => {
  const checkoutRoute = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  const paymentRoute = readFileSync('functions/src/api/routes/payments.ts', 'utf8');
  const expiry = readFileSync('functions/src/scheduled/paymentReservations.ts', 'utf8');
  assert.match(checkoutRoute, /runTransaction/);
  assert.match(checkoutRoute, /newStock:\s*currentStock\s*-\s*item\.quantity/);
  assert.match(checkoutRoute, /stockReservationStatus/);
  assert.match(paymentRoute, /stockRestorationApplied !== true/);
  assert.match(paymentRoute, /stock:\s*\(Number\.isFinite\(stock\) \? stock : 0\) \+ quantity/);
  assert.match(paymentRoute, /Insufficient stock to retry payment/);
  assert.match(expiry, /stockReservationStatus[\s\S]*reserved/);
  assert.match(expiry, /stockRestorationApplied:\s*true/);
});

test('order cancellation releases unpaid reservations without rewriting a verified payment', () => {
  const orders = readFileSync('functions/src/api/routes/orders.ts', 'utf8');
  assert.match(orders, /cancellingUnsettledPayHere/);
  assert.match(orders, /new Set\(\["awaiting_payment", "pending"\]\)/);
  assert.match(orders, /payment_transactions/);
  assert.match(orders, /cancellingPaidPayHere/);
  assert.match(orders, /paymentReviewReason:\s*"cancelled_paid_order"/);
});

test('payment fulfillment is webhook-only with exact verification and duplicate protection', () => {
  const paymentRoute = readFileSync('functions/src/api/routes/payments.ts', 'utf8');
  assert.match(paymentRoute, /verifyPayHereNotification/);
  assert.match(paymentRoute, /amountsMatch\(Number\(payment\.amount\), notification\.amount\)/);
  assert.match(paymentRoute, /payment_receipts/);
  assert.match(paymentRoute, /payment\.status === "paid" && mappedStatus === "paid"/);
  assert.match(paymentRoute, /mappedStatus === "paid"[\s\S]*status:\s*"confirmed"/);
  assert.match(paymentRoute, /manual_review/);
  assert.doesNotMatch(readFileSync('src/features/checkout/PaymentReturnPage.tsx', 'utf8'), /outcome\s*===\s*['"]return['"][\s\S]{0,120}paymentStatus:\s*['"]paid/);
});

test('private payment and notification collections cannot be read or written by storefront clients', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  for (const collection of ['payment_transactions', 'payment_receipts', 'notification_outbox', 'mail']) {
    assert.match(rules, new RegExp(`match \/${collection}\/\\{[^}]+\\} \\{[\\s\\S]*?allow read, write: if false;`));
  }
});

test('email notifications are escaped, idempotent and future-ready for additional channels', () => {
  const notifications = readFileSync('functions/src/triggers/orderNotifications.ts', 'utf8');
  assert.match(notifications, /escapeHtml/);
  assert.match(notifications, /notificationId\(eventId, orderId, message\.kind, message\.to\)/);
  assert.match(notifications, /collection\("notification_outbox"\)/);
  assert.match(notifications, /channel:\s*"email"/);
  assert.match(notifications, /order_confirmation/);
  assert.match(notifications, /payment_confirmation/);
  assert.match(notifications, /order_status/);
  assert.match(notifications, /admin_new_order/);
  assert.match(notifications, /admin_payment/);
});

test('App Check, rate limits, safe telemetry and launch SEO are connected without trusting client data', () => {
  const api = readFileSync('functions/src/api/app.ts', 'utf8');
  const payments = readFileSync('functions/src/api/routes/payments.ts', 'utf8');
  const analytics = readFileSync('src/services/observability/commerceAnalytics.ts', 'utf8');
  const diagnostics = readFileSync('src/services/observability/clientDiagnostics.ts', 'utf8');
  const seo = readFileSync('src/services/seo/storefrontSeo.ts', 'utf8');
  assert.match(api, /adminAppCheck\.verifyToken/);
  assert.match(api, /x-firebase-appcheck/i);
  assert.match(payments, /enforceWebhookLimit/);
  assert.match(payments, /enforcePaymentMutationLimit/);
  assert.match(analytics, /add_to_cart/);
  assert.match(analytics, /begin_checkout/);
  assert.match(analytics, /purchase/);
  assert.doesNotMatch(diagnostics, /stack:/);
  assert.match(seo, /Organization/);
  assert.match(seo, /OnlineStore/);
  assert.match(seo, /BreadcrumbList/);
  assert.match(seo, /Product/);
  assert.match(readFileSync('src/features/reviews/reviewApi.ts', 'utf8'), /getAppCheckRequestHeaders/);
  assert.match(readFileSync('src/components/AdminDashboard.tsx', 'utf8'), /getAppCheckRequestHeaders/);
  assert.match(readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8'), /getAppCheckRequestHeaders/);
});

test('payment return UI includes polling, focus, screen-reader status and reduced-motion support', () => {
  const page = readFileSync('src/features/checkout/PaymentReturnPage.tsx', 'utf8');
  const styles = readFileSync('src/features/checkout/paymentReturn.css', 'utf8');
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /role="status"/);
  assert.match(page, /current\?\.focus\(\)/);
  assert.match(page, /setTimeout/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(max-width:/);
});
