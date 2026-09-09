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

test('canonical delivery fallback is 350 and 5000 when settings are missing', () => {
  const settings = normalizeWebsiteSettings(null);

  assert.equal(DEFAULT_DELIVERY_CHARGE, 350);
  assert.equal(DEFAULT_FREE_DELIVERY_MIN, 5000);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.deliveryCharge, 350);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.freeDeliveryMin, 5000);
  assert.equal(settings.deliveryCharge, 350);
  assert.equal(settings.freeDeliveryMin, 5000);
});

test('partial settings use canonical fallback only for the missing field', () => {
  const missingCharge = normalizeWebsiteSettings({ freeDeliveryMin: 7000 });
  const missingThreshold = normalizeWebsiteSettings({ deliveryCharge: 425 });
  const configured = normalizeWebsiteSettings({ deliveryCharge: 425, freeDeliveryMin: 7000 });
  const backendMissingCharge = calculateCheckoutTotals(4999, 'Gampaha', { freeDeliveryMin: 7000 });
  const backendMissingThreshold = calculateCheckoutTotals(4999, 'Gampaha', { deliveryCharge: 425 });

  assert.equal(missingCharge.deliveryCharge, 350);
  assert.equal(missingCharge.freeDeliveryMin, 7000);
  assert.equal(missingThreshold.deliveryCharge, 425);
  assert.equal(missingThreshold.freeDeliveryMin, 5000);
  assert.equal(configured.deliveryCharge, 425);
  assert.equal(configured.freeDeliveryMin, 7000);
  assert.equal(backendMissingCharge.baseDeliveryCharge, 350);
  assert.equal(backendMissingCharge.freeDeliveryThreshold, 7000);
  assert.equal(backendMissingCharge.deliveryFee, 350);
  assert.equal(backendMissingThreshold.baseDeliveryCharge, 425);
  assert.equal(backendMissingThreshold.freeDeliveryThreshold, 5000);
  assert.equal(backendMissingThreshold.deliveryFee, 425);
});

test('frontend and backend fallback totals agree below, at, and above the threshold', () => {
  const below = calculateCheckoutTotals(4999, 'Gampaha', null);
  const atThreshold = calculateCheckoutTotals(5000, 'Gampaha', null);
  const above = calculateCheckoutTotals(5001, 'Gampaha', null);

  assert.equal(below.deliveryFee, 350);
  assert.equal(below.baseDeliveryCharge, 350);
  assert.equal(below.freeDeliveryThreshold, 5000);
  assert.equal(atThreshold.deliveryFee, 0);
  assert.equal(above.deliveryFee, 0);
  assert.equal(resolveDeliveryCharge(null, 'Gampaha', DEFAULT_DELIVERY_CHARGE), 350);
  assert.equal(SERVER_DEFAULT_DELIVERY_CHARGE, DEFAULT_DELIVERY_CHARGE);
  assert.equal(SERVER_DEFAULT_FREE_DELIVERY_MIN, DEFAULT_FREE_DELIVERY_MIN);
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
