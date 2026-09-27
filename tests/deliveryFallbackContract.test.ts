import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_DELIVERY_CHARGE as SERVER_DEFAULT_DELIVERY_CHARGE,
  DEFAULT_FREE_DELIVERY_MIN as SERVER_DEFAULT_FREE_DELIVERY_MIN,
  calculateCheckoutTotals,
} from '../functions/src/api/checkout/checkoutLogic';
import { resolveDeliveryCharge } from '../src/services/settings/shippingSettings';
import {
  DEFAULT_DELIVERY_CHARGE,
  DEFAULT_FREE_DELIVERY_MIN,
  DEFAULT_WEBSITE_SETTINGS,
  normalizeWebsiteSettings,
} from '../src/services/settings/websiteSettings';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('canonical delivery fallback is 300 and 3500 when settings are missing', () => {
  const settings = normalizeWebsiteSettings(null);

  assert.equal(DEFAULT_DELIVERY_CHARGE, 300);
  assert.equal(DEFAULT_FREE_DELIVERY_MIN, 3500);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.deliveryCharge, 300);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.freeDeliveryMin, 3500);
  assert.equal(settings.deliveryCharge, 300);
  assert.equal(settings.freeDeliveryMin, 3500);
});

test('partial settings use canonical fallback only for the missing field', () => {
  const missingCharge = normalizeWebsiteSettings({ freeDeliveryMin: 7000 });
  const missingThreshold = normalizeWebsiteSettings({ deliveryCharge: 425 });
  const configured = normalizeWebsiteSettings({ deliveryCharge: 425, freeDeliveryMin: 7000 });
  const backendMissingCharge = calculateCheckoutTotals(4999, 'Gampaha', { freeDeliveryMin: 7000 });
  const backendMissingThreshold = calculateCheckoutTotals(3499, 'Gampaha', { deliveryCharge: 425 });

  assert.equal(missingCharge.deliveryCharge, 300);
  assert.equal(missingCharge.freeDeliveryMin, 7000);
  assert.equal(missingThreshold.deliveryCharge, 425);
  assert.equal(missingThreshold.freeDeliveryMin, 3500);
  assert.equal(configured.deliveryCharge, 425);
  assert.equal(configured.freeDeliveryMin, 7000);
  assert.equal(backendMissingCharge.baseDeliveryCharge, 300);
  assert.equal(backendMissingCharge.freeDeliveryThreshold, 7000);
  assert.equal(backendMissingCharge.deliveryFee, 300);
  assert.equal(backendMissingThreshold.baseDeliveryCharge, 425);
  assert.equal(backendMissingThreshold.freeDeliveryThreshold, 3500);
  assert.equal(backendMissingThreshold.deliveryFee, 425);
});

test('frontend and backend fallback totals agree below, at, and above the threshold', () => {
  const below = calculateCheckoutTotals(3499, 'Gampaha', null);
  const atThreshold = calculateCheckoutTotals(3500, 'Gampaha', null);
  const above = calculateCheckoutTotals(3501, 'Gampaha', null);
  const wellAbove = calculateCheckoutTotals(5000, 'Gampaha', null);
  const empty = calculateCheckoutTotals(0, 'Gampaha', null);

  assert.equal(below.deliveryFee, 300);
  assert.equal(below.grandTotalPrice, 3799);
  assert.equal(below.baseDeliveryCharge, 300);
  assert.equal(below.freeDeliveryThreshold, 3500);
  assert.equal(atThreshold.deliveryFee, 0);
  assert.equal(atThreshold.grandTotalPrice, 3500);
  assert.equal(above.deliveryFee, 0);
  assert.equal(wellAbove.deliveryFee, 0);
  assert.equal(empty.deliveryFee, 0);
  assert.equal(empty.grandTotalPrice, 0);
  assert.equal(resolveDeliveryCharge(null, 'Gampaha', DEFAULT_DELIVERY_CHARGE), 300);
  assert.equal(SERVER_DEFAULT_DELIVERY_CHARGE, DEFAULT_DELIVERY_CHARGE);
  assert.equal(SERVER_DEFAULT_FREE_DELIVERY_MIN, DEFAULT_FREE_DELIVERY_MIN);
});

test('free delivery qualifies on the discounted selling-price subtotal, never the original price', () => {
  const regularPrice = 4000;
  const sellingPrice = 3400;
  const discounted = calculateCheckoutTotals(sellingPrice, 'Colombo', null);

  assert.ok(regularPrice >= DEFAULT_FREE_DELIVERY_MIN);
  assert.equal(discounted.itemsSubtotal, 3400);
  assert.equal(discounted.deliveryFee, 300);
  assert.equal(discounted.grandTotalPrice, 3700);

  const checkoutRoute = read('functions/src/api/routes/checkout.ts');
  assert.match(checkoutRoute, /const truePrice = Number\(pData\.price\)/);
  assert.match(checkoutRoute, /itemsSubtotal \+= truePrice \* item\.quantity/);
  assert.doesNotMatch(checkoutRoute, /itemsSubtotal \+=[^\n]*originalPrice/);
});

test('delivery fee never helps an order qualify for free delivery', () => {
  const totals = calculateCheckoutTotals(3300, 'Colombo', null);

  assert.equal(totals.deliveryFee, 300);
  assert.equal(totals.itemsSubtotal + totals.deliveryFee, 3600);
  assert.ok(totals.itemsSubtotal + totals.deliveryFee >= DEFAULT_FREE_DELIVERY_MIN);
});

test('coupon discounts do not change the free-delivery eligibility decision', () => {
  const qualifiedWithCoupon = calculateCheckoutTotals(3600, 'Colombo', null, 400);
  const belowWithCoupon = calculateCheckoutTotals(3499, 'Colombo', null, 400);

  assert.equal(qualifiedWithCoupon.discountAmount, 400);
  assert.equal(qualifiedWithCoupon.deliveryFee, 0);
  assert.equal(qualifiedWithCoupon.grandTotalPrice, 3200);
  assert.equal(belowWithCoupon.deliveryFee, 300);
  assert.equal(belowWithCoupon.grandTotalPrice, 3399);
});

test('valid production settings remain authoritative for checkout totals', () => {
  const settings = { deliveryCharge: 425, freeDeliveryMin: 7000 };
  const totals = calculateCheckoutTotals(6999, 'Kandy', settings);

  assert.equal(totals.deliveryFee, 425);
  assert.equal(totals.baseDeliveryCharge, 425);
  assert.equal(totals.freeDeliveryThreshold, 7000);
  assert.equal(calculateCheckoutTotals(7000, 'Kandy', settings).deliveryFee, 0);
});

test('active fallback paths contain no stale 500 or 150000 defaults', () => {
  const websiteSettings = read('src/services/settings/websiteSettings.ts');
  const adminDashboard = read('src/components/AdminDashboard.tsx');
  const checkoutDrawer = read('src/features/checkout/PremiumCheckoutDrawer.tsx');
  const checkoutLogic = read('functions/src/api/checkout/checkoutLogic.ts');

  for (const source of [websiteSettings, adminDashboard, checkoutDrawer, checkoutLogic]) {
    assert.doesNotMatch(source, /deliveryCharge:\s*500\b/);
    assert.doesNotMatch(source, /freeDeliveryMin:\s*150000\b/);
    assert.doesNotMatch(source, /DISTRICT_DELIVERY/);
  }
});
