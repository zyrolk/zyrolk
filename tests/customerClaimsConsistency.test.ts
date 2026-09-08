import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getCanonicalBusinessHours } from '../src/components/ContactPage';
import { calculateCheckoutTotals, validateCheckoutDetails } from '../functions/src/api/checkout/checkoutLogic';
import { DEFAULT_WEBSITE_SETTINGS, normalizeWebsiteSettings } from '../src/services/settings/websiteSettings';

const contact = readFileSync('src/components/ContactPage.tsx', 'utf8');
const cms = readFileSync('src/components/CmsPage.tsx', 'utf8');

test('Contact renders configured business hours instead of CMS hours', () => {
  assert.deepEqual(getCanonicalBusinessHours({
    businessHours: {
      weekdays: '10:00 AM - 4:00 PM',
      saturday: '10:00 AM - 1:00 PM',
      sunday: 'Closed',
    },
  }), [
    { label: 'Weekdays', value: '10:00 AM - 4:00 PM' },
    { label: 'Saturday', value: '10:00 AM - 1:00 PM' },
    { label: 'Sunday', value: 'Closed' },
  ]);
  assert.match(contact, /const hoursItems = getCanonicalBusinessHours\(settings\)/);
  assert.doesNotMatch(contact, /hoursItems = parsed\.hoursItems/);
});

test('Contact uses one safe production-default business-hours fallback', () => {
  assert.deepEqual(getCanonicalBusinessHours(null), [
    { label: 'Weekdays', value: '9:00 AM - 6:00 PM' },
    { label: 'Saturday', value: '9:00 AM - 5:00 PM' },
    { label: 'Sunday', value: 'Closed' },
  ]);
  assert.deepEqual(getCanonicalBusinessHours({
    businessHours: { weekdays: ' ', saturday: '', sunday: 'Closed' },
  }), [
    { label: 'Weekdays', value: '9:00 AM - 6:00 PM' },
    { label: 'Saturday', value: '9:00 AM - 5:00 PM' },
    { label: 'Sunday', value: 'Closed' },
  ]);
  assert.deepEqual(DEFAULT_WEBSITE_SETTINGS.businessHours, {
    weekdays: '9:00 AM - 6:00 PM',
    saturday: '9:00 AM - 5:00 PM',
    sunday: 'Closed',
  });
});

test('Fallback shipping copy matches the flat fee and inclusive threshold', () => {
  const settings = normalizeWebsiteSettings({
    ...DEFAULT_WEBSITE_SETTINGS,
    deliveryCharge: 350,
    freeDeliveryMin: 5000,
  });
  assert.equal(calculateCheckoutTotals(4999, 'Colombo', settings).deliveryFee, 350);
  assert.equal(calculateCheckoutTotals(5000, 'Colombo', settings).deliveryFee, 0);
  assert.match(cms, /Delivery fee is LKR 350 for orders below LKR 5,000/);
  assert.match(cms, /Free delivery is available on orders of LKR 5,000 or more/);
  assert.doesNotMatch(cms, /Shipping costs vary based on your district/);
  assert.doesNotMatch(cms, /orders that exceed our minimum threshold/);
});

test('Fallback ETA copy makes no unsupported numeric promise', () => {
  assert.match(cms, /Delivery times may vary by location\. Estimated delivery information will be provided where available\./);
  assert.doesNotMatch(cms, /1 to 3 business days|3 to 5 business days|1–3 Business Days|2–5 Business Days/);
});

test('WhatsApp remains support and order assistance, not a payment method', () => {
  assert.match(cms, /WhatsApp is available for customer support and order assistance only; it is not a separate payment method\./);
  assert.doesNotMatch(cms, /WhatsApp payment confirmations/);
  assert.match(contact, /Chat on WhatsApp/);
  assert.match(contact, /settings\.whatsappNumber/);
});

test('COD checkout behavior remains unchanged', () => {
  assert.doesNotThrow(() => validateCheckoutDetails({
    customerName: 'Test Customer',
    customerPhone: '0771234567',
    customerAddress: 'No 1, Main Street',
    district: 'Colombo',
    paymentMethod: 'cod',
  }));
  assert.throws(() => validateCheckoutDetails({
    customerName: 'Test Customer',
    customerPhone: '0771234567',
    customerAddress: 'No 1, Main Street',
    district: 'Colombo',
    paymentMethod: 'card',
  }), /Payment method must be cod, whatsapp_confirm or payhere/);
});
