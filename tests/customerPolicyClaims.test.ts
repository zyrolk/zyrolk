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
  assert.match(cms, /Islandwide Delivery: Delivery is available across Sri Lanka/);
  assert.match(cms, /Delivery fee is LKR 350 for orders below LKR 5,000/);
  assert.match(cms, /Free delivery is available on orders of LKR 5,000 or more/);
  assert.match(cms, /Delivery times may vary by location\. Estimated delivery information will be provided where available\./);
  assert.match(cms, /We currently support Cash on Delivery \(COD\)/);
  assert.match(cms, /WhatsApp is available for customer support and order assistance only; it is not a separate payment method\./);
  assert.match(cms, /Need help with an order or product\? Contact our support team on WhatsApp for assistance\./);
  assert.match(contact, /Business Hours: Daily, 8:00 AM - 10:00 PM/);
  assert.match(admin, /Delivery fee is LKR 350 for orders below LKR 5,000/);
  assert.match(admin, /Free delivery is available on orders of LKR 5,000 or more/);
  assert.match(admin, /Need help with an order or product\? Contact our support team on WhatsApp for assistance\./);
});

test('live CMS documents continue to override fallback content', () => {
  assert.match(cms, /getDoc\(doc\(db, "pages", pageId\)\)/);
  assert.match(cms, /if \(docSnap\.exists\(\)\)/);
  assert.match(cms, /content: data\.content/);
  assert.match(cms, /DEFAULT_PAGES\.find\(p => p\.id === pageId\)/);
});
