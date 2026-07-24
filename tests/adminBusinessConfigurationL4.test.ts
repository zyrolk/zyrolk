import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculateCheckoutTotals } from '../functions/src/api/checkout/checkoutLogic';
import { validateStoreSettings } from '../src/services/settings/storeSettingsValidation';
import { resolveDeliveryArea, resolveDeliveryCharge } from '../src/services/settings/shippingSettings';
import { DEFAULT_WEBSITE_SETTINGS, normalizeWebsiteSettings } from '../src/services/settings/websiteSettings';

test('legacy website settings receive launch-safe defaults without changing existing values', () => {
  const settings = normalizeWebsiteSettings({ storeName: 'Legacy Store', whatsappNumber: '', heroBanners: [], deliveryCharge: 425, freeDeliveryMin: 7000 });
  assert.equal(settings.storeName, 'Legacy Store');
  assert.equal(settings.deliveryCharge, 425);
  assert.equal(settings.currency, 'LKR');
  assert.equal(settings.storeStatus, 'open');
  assert.equal(settings.registrationEnabled, true);
  assert.equal(settings.maintenanceMode, false);
  assert.equal(settings.homepageSections?.featured.enabled, true);
  assert.deepEqual(settings.deliveryAreas, []);
});

test('delivery area configuration is applied consistently with flat-charge fallback', () => {
  const settings = normalizeWebsiteSettings({
    ...DEFAULT_WEBSITE_SETTINGS,
    deliveryCharge: 500,
    deliveryAreas: [{ id: 'western', name: 'Western', districts: ['Colombo', 'Gampaha'], charge: 350, estimatedDelivery: '1-2 days', isActive: true }],
  });
  assert.equal(resolveDeliveryArea(settings, ' colombo ')?.id, 'western');
  assert.equal(resolveDeliveryCharge(settings, 'Colombo', 600), 350);
  assert.equal(resolveDeliveryCharge(settings, 'Kandy', 600), 500);
  assert.equal(calculateCheckoutTotals(1000, 'Colombo', settings).deliveryFee, 350);
  assert.equal(calculateCheckoutTotals(1000, 'Kandy', settings).deliveryFee, 500);
});

test('business configuration validation rejects unsafe or ambiguous settings', () => {
  const settings = normalizeWebsiteSettings({
    ...DEFAULT_WEBSITE_SETTINGS,
    maintenanceMode: true,
    maintenanceMessage: '',
    deliveryAreas: [
      { id: 'one', name: 'One', districts: ['Colombo'], charge: 300, estimatedDelivery: '1 day', isActive: true },
      { id: 'two', name: 'Two', districts: ['colombo'], charge: -1, estimatedDelivery: '', isActive: true },
    ],
  });
  const result = validateStoreSettings({ settings, deliveryCharge: '500', freeDeliveryMin: '5000' });
  assert.ok(result.errors.some((error) => error.includes('maintenance message')));
  assert.ok(result.errors.some((error) => error.includes('duplicate district')));
  assert.ok(result.errors.some((error) => error.includes('non-negative')));
});

test('Admin and storefront keep payment configuration disabled without requiring a merchant secret', () => {
  const admin = readFileSync(new URL('../src/components/AdminDashboard.tsx', import.meta.url), 'utf8');
  const businessEditor = readFileSync(new URL('../src/components/admin/BusinessConfigurationEditor.tsx', import.meta.url), 'utf8');
  const paymentRoute = readFileSync(new URL('../functions/src/api/routes/adminConfiguration.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/components/MarketplaceHomePhase1.tsx', import.meta.url), 'utf8');
  assert.match(admin, /BusinessConfigurationEditor/);
  assert.match(admin, /PaymentConfigurationPanel/);
  assert.match(businessEditor, /Homepage merchandising/);
  assert.match(businessEditor, /Delivery areas/);
  assert.match(app, /StorefrontMaintenance/);
  assert.match(app, /registrationEnabled/);
  assert.match(home, /homepageSections\.bestSellers\.enabled/);
  assert.match(paymentRoute, /temporarily_disabled/);
  assert.match(paymentRoute, /Cash on Delivery is the only available payment method/);
  assert.doesNotMatch(paymentRoute, /PAYHERE_MERCHANT_SECRET/);
});

test('warranty CMS and notification controls are connected', () => {
  const cms = readFileSync(new URL('../src/components/CmsPage.tsx', import.meta.url), 'utf8');
  const footer = readFileSync(new URL('../src/components/Footer.tsx', import.meta.url), 'utf8');
  const notifications = readFileSync(new URL('../functions/src/triggers/orderNotifications.ts', import.meta.url), 'utf8');
  assert.match(cms, /warranty-policy/);
  assert.match(footer, /warranty-policy/);
  assert.match(notifications, /emailNotificationsEnabled === false/);
  assert.match(notifications, /orderNotificationsEnabled/);
});
