import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStoreSettings } from '../src/services/settings/storeSettingsValidation';
import type { WebsiteSettings } from '../src/types';

const settings = (overrides: Partial<WebsiteSettings> = {}): WebsiteSettings => ({
  storeName: 'Zyro.lk',
  whatsappNumber: '+94771234567',
  heroBanners: [],
  deliveryCharge: 500,
  freeDeliveryMin: 5000,
  ...overrides,
});

test('store settings accepts optional blank contacts and valid non-negative delivery amounts', () => {
  const result = validateStoreSettings({ settings: settings({ whatsappNumber: '' }), deliveryCharge: '0', freeDeliveryMin: '5000' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.deliveryCharge, 0);
  assert.equal(result.freeDeliveryMin, 5000);
});

test('store settings rejects invalid identity, contact, media and delivery fields', () => {
  const result = validateStoreSettings({
    settings: settings({ storeName: ' ', logoUrl: 'javascript:bad', faviconUrl: '/favicon.png', contactEmail: 'bad', contactPhone: '123', whatsappNumber: 'hello' }),
    deliveryCharge: '-1',
    freeDeliveryMin: 'free',
  });
  assert.deepEqual(result.errors, [
    'Store name is required.',
    'Logo must use a valid http or https URL.',
    'Favicon must use a valid http or https URL.',
    'Contact email is invalid.',
    'Primary phone number is invalid.',
    'WhatsApp number is invalid.',
    'Delivery charge must be a non-negative number.',
    'Free delivery threshold must be a non-negative number.',
  ]);
});
