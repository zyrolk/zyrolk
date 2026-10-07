import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cms = readFileSync('src/components/CmsPage.tsx', 'utf8');
const contact = readFileSync('src/components/ContactPage.tsx', 'utf8');
const admin = readFileSync('src/components/AdminDashboard.tsx', 'utf8');

test('fallback policy copy avoids unsupported authenticity, warranty, return, and ETA guarantees', () => {
  const unsupportedFallbackClaims = /Sri Lanka's premier destination|direct-import|100% Genuine Products|Only authentic global hardware|No refurbished or counterfeit|7-Day Priority Replacement|within 7 days|immediate direct replacement|active local service centers|authorized local service centers|all 25 districts|real-time|fastest response|custom product ordering|brand warranties/;

  assert.doesNotMatch(cms, unsupportedFallbackClaims);
  assert.doesNotMatch(contact, unsupportedFallbackClaims);
  assert.doesNotMatch(admin, unsupportedFallbackClaims);
});

test('fallback copy preserves the verified launch claims', () => {
  assert.match(cms, /Islandwide Delivery: Estimated delivery: 2–5 days\. Delivery time may vary by location, courier, product availability, weather, or other exceptional conditions\./);
  assert.match(cms, /Delivery fee is LKR 300 for orders below LKR 3,000\./);
  assert.match(cms, /Orders from LKR 3,000 to below LKR 5,000 qualify for LKR 150 delivery\./);
  assert.match(cms, /Delivery is free for orders of LKR 5,000 or more\./);
  assert.match(cms, /Estimated delivery: 2–5 days\. Delivery time may vary by location, courier, product availability, weather, or other exceptional conditions\./);
  assert.match(cms, /Cash on Delivery is currently the only payment option available at checkout\./);
  assert.match(cms, /WhatsApp is available for customer support and order assistance only; it is not a separate payment method\./);
  assert.match(cms, /Need help with an order or product\? Contact our support team on WhatsApp for assistance\./);
  assert.match(contact, /Business Hours: Daily, 8:00 AM - 10:00 PM/);
  assert.match(admin, /Delivery fee is LKR 300 for orders below LKR 3,000\./);
  assert.match(admin, /Orders from LKR 3,000 to below LKR 5,000 qualify for LKR 150 delivery\./);
  assert.match(admin, /Delivery is free for orders of LKR 5,000 or more\./);
  assert.match(admin, /Estimated delivery: 2–5 days\. Delivery time may vary by location, courier, product availability, weather, or other exceptional conditions\./);
  const adminEtaLines = admin.split(/\r?\n/).filter((line) => line.includes('Estimated delivery: 2–5 days')).join('\n');
  assert.doesNotMatch(adminEtaLines, /guaranteed|guarantee|same[- ]day|express delivery/i);
  assert.doesNotMatch(admin, /LKR 350 for orders|LKR 3,500/);
  assert.match(admin, /Need help with an order or product\? Contact our support team on WhatsApp for assistance\./);
});

test('Terms fallback and Admin default use the same COD-only payment wording', () => {
  const codOnlySentence = 'Cash on Delivery is currently the only payment option available at checkout.';
  assert.match(cms, new RegExp(codOnlySentence));
  assert.match(admin, new RegExp(codOnlySentence));
  assert.doesNotMatch(cms, /Available payment options are shown during checkout\./);
  assert.doesNotMatch(admin, /Available payment options are shown during checkout\./);
  assert.doesNotMatch(cms, /PayHere|card payment|online payment/iu);
  assert.doesNotMatch(admin, /PayHere|card payment|online payment/iu);
});

test('live CMS documents continue to override fallback content', () => {
  assert.match(cms, /getDoc\(doc\(db, "pages", pageId\)\)/);
  assert.match(cms, /if \(docSnap\.exists\(\)\)/);
  assert.match(cms, /content: data\.content/);
  assert.match(cms, /DEFAULT_PAGES\.find\(p => p\.id === pageId\)/);
});
