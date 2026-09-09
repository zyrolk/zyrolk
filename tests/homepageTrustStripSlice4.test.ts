import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const trust = readFileSync('src/components/HomepageTrustStrip.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice4Styles = styles.slice(
  styles.indexOf('/* Homepage redesign Slice 4'),
  styles.indexOf('/* Homepage redesign Slice 5'),
);

test('Slice 4 keeps the existing four factual reassurance claims', () => {
  for (const claim of [
    'Cash on Delivery',
    'Pay when your order arrives.',
    'Islandwide Delivery',
    'Convenient delivery across Sri Lanka.',
    'Secure Checkout',
    'Your order is securely processed.',
    'Customer Support',
    'Daily, 8:00 AM - 10:00 PM.',
  ]) {
    assert.match(trust, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }

  assert.doesNotMatch(trust, /Secure Payments|card payments?|online payments?|PayHere|100% Safe|Easy Returns|guaranteed|24\/7/iu);
});

test('Slice 4 preserves the existing homepage placement and static data shape', () => {
  assert.match(homepage, /<HomepageTrustStrip \/>/);
  assert.ok(homepage.indexOf('<HomepageTrustStrip />') < homepage.indexOf('zy-home-category-promos'));
  assert.match(trust, /TRUST_ITEMS/);
  assert.match(trust, /TRUST_ITEMS\.map/);
  assert.match(trust, /aria-label="Why customers can shop with confidence"/);
});

test('Slice 4 styles a compact blue-icon strip with mobile-safe wrapping only', () => {
  assert.match(styles, /Slice 4: compact factual trust strip/);
  assert.match(slice4Styles, /zy-launch-trust-grid[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(slice4Styles, /zy-launch-trust-item \+ \.zy-launch-trust-item[\s\S]*border-left/);
  assert.match(slice4Styles, /zy-launch-trust-icon[\s\S]*color: #2563eb/);
  assert.match(slice4Styles, /@media \(max-width: 767px\)[\s\S]*zy-launch-trust-grid[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(slice4Styles, /@media \(max-width: 389px\)[\s\S]*zy-launch-trust-item[\s\S]*flex-direction: row/);
  assert.doesNotMatch(slice4Styles, /zy-ai-hero|zy-foundation-category|zy-storefront-product-shelf|zy-launch-footer|zy-mobile-dock/iu);
});
