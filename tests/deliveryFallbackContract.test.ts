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

test('canonical delivery fallback is 300 and 5000 with the reduced tier off when settings are missing', () => {
  const settings = normalizeWebsiteSettings(null);

  assert.equal(DEFAULT_DELIVERY_CHARGE, 300);
  assert.equal(DEFAULT_FREE_DELIVERY_MIN, 5000);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.deliveryCharge, 300);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.freeDeliveryMin, 5000);
  assert.equal(settings.deliveryCharge, 300);
  assert.equal(settings.freeDeliveryMin, 5000);
  assert.equal(Object.hasOwn(DEFAULT_WEBSITE_SETTINGS, 'reducedDeliveryMin'), false);
  assert.equal(Object.hasOwn(DEFAULT_WEBSITE_SETTINGS, 'reducedDeliveryCharge'), false);
  assert.equal(Object.hasOwn(settings, 'reducedDeliveryMin'), false);
  assert.equal(Object.hasOwn(settings, 'reducedDeliveryCharge'), false);
});

test('partial settings use canonical fallback only for the missing field', () => {
  const missingCharge = normalizeWebsiteSettings({ freeDeliveryMin: 7000 });
  const missingThreshold = normalizeWebsiteSettings({ deliveryCharge: 425 });
  const configured = normalizeWebsiteSettings({ deliveryCharge: 425, freeDeliveryMin: 7000 });
  const backendMissingCharge = calculateCheckoutTotals(4999, 'Gampaha', { freeDeliveryMin: 7000 });
  const backendMissingThreshold = calculateCheckoutTotals(4999, 'Gampaha', { deliveryCharge: 425 });

  assert.equal(missingCharge.deliveryCharge, 300);
  assert.equal(missingCharge.freeDeliveryMin, 7000);
  assert.equal(missingThreshold.deliveryCharge, 425);
  assert.equal(missingThreshold.freeDeliveryMin, 5000);
  assert.equal(configured.deliveryCharge, 425);
  assert.equal(configured.freeDeliveryMin, 7000);
  assert.equal(backendMissingCharge.baseDeliveryCharge, 300);
  assert.equal(backendMissingCharge.freeDeliveryThreshold, 7000);
  assert.equal(backendMissingCharge.deliveryFee, 300);
  assert.equal(backendMissingThreshold.baseDeliveryCharge, 425);
  assert.equal(backendMissingThreshold.freeDeliveryThreshold, 5000);
  assert.equal(backendMissingThreshold.deliveryFee, 425);
});

test('frontend and backend fallback totals agree below, at, and above the threshold', () => {
  const reducedBand = calculateCheckoutTotals(3000, 'Gampaha', null);
  const below = calculateCheckoutTotals(4999, 'Gampaha', null);
  const atThreshold = calculateCheckoutTotals(5000, 'Gampaha', null);
  const above = calculateCheckoutTotals(5001, 'Gampaha', null);
  const wellAbove = calculateCheckoutTotals(8000, 'Gampaha', null);
  const empty = calculateCheckoutTotals(0, 'Gampaha', null);

  assert.equal(reducedBand.deliveryFee, 300, 'the reduced tier is never enabled by code defaults');
  assert.equal(below.deliveryFee, 300);
  assert.equal(below.grandTotalPrice, 5299);
  assert.equal(below.baseDeliveryCharge, 300);
  assert.equal(below.freeDeliveryThreshold, 5000);
  assert.equal(atThreshold.deliveryFee, 0);
  assert.equal(atThreshold.grandTotalPrice, 5000);
  assert.equal(above.deliveryFee, 0);
  assert.equal(wellAbove.deliveryFee, 0);
  assert.equal(empty.deliveryFee, 0);
  assert.equal(empty.grandTotalPrice, 0);
  assert.equal(resolveDeliveryCharge(null, 'Gampaha', DEFAULT_DELIVERY_CHARGE), 300);
  assert.equal(SERVER_DEFAULT_DELIVERY_CHARGE, DEFAULT_DELIVERY_CHARGE);
  assert.equal(SERVER_DEFAULT_FREE_DELIVERY_MIN, DEFAULT_FREE_DELIVERY_MIN);
});

test('free delivery qualifies on the discounted selling-price subtotal, never the original price', () => {
  const regularPrice = 5500;
  const sellingPrice = 4600;
  const discounted = calculateCheckoutTotals(sellingPrice, 'Colombo', null);

  assert.ok(regularPrice >= DEFAULT_FREE_DELIVERY_MIN);
  assert.equal(discounted.itemsSubtotal, 4600);
  assert.equal(discounted.deliveryFee, 300);
  assert.equal(discounted.grandTotalPrice, 4900);

  const checkoutRoute = read('functions/src/api/routes/checkout.ts');
  assert.match(checkoutRoute, /const truePrice = Number\(pData\.price\)/);
  assert.match(checkoutRoute, /itemsSubtotal \+= truePrice \* item\.quantity/);
  assert.doesNotMatch(checkoutRoute, /itemsSubtotal \+=[^\n]*originalPrice/);
});

test('delivery fee never helps an order qualify for free delivery', () => {
  const totals = calculateCheckoutTotals(4800, 'Colombo', null);

  assert.equal(totals.deliveryFee, 300);
  assert.equal(totals.itemsSubtotal + totals.deliveryFee, 5100);
  assert.ok(totals.itemsSubtotal + totals.deliveryFee >= DEFAULT_FREE_DELIVERY_MIN);
});

test('coupon discounts do not change the free-delivery eligibility decision', () => {
  const qualifiedWithCoupon = calculateCheckoutTotals(5100, 'Colombo', null, 400);
  const belowWithCoupon = calculateCheckoutTotals(4999, 'Colombo', null, 400);

  assert.equal(qualifiedWithCoupon.discountAmount, 400);
  assert.equal(qualifiedWithCoupon.deliveryFee, 0);
  assert.equal(qualifiedWithCoupon.grandTotalPrice, 4700);
  assert.equal(belowWithCoupon.deliveryFee, 300);
  assert.equal(belowWithCoupon.grandTotalPrice, 4899);
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
