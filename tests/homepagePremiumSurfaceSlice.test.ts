import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const premiumStyles = styles.slice(styles.indexOf('/* Homepage premium surface pass'));

test('premium homepage surfaces stay scoped to the live homepage shell', () => {
  assert.match(premiumStyles, /\.zy-penpot-storefront \.zy-launch-home \{[\s\S]*--zy-home-background: #eef6ff/);
  assert.match(premiumStyles, /--zy-home-surface: #ffffff/);
  assert.match(premiumStyles, /--zy-home-section: #e6f0ff/);
  assert.match(premiumStyles, /--zy-home-primary: #2563eb/);
  assert.match(premiumStyles, /--zy-home-text: #0b1f4a/);
  assert.match(premiumStyles, /--zy-home-muted: #5b6b83/);
  assert.match(premiumStyles, /--zy-home-border: #d9e7f7/);
  assert.match(premiumStyles, /:has\(\.zy-launch-home\)[\s\S]*zy-compact-mobile-header-shell[\s\S]*--zy-home-background/);
  assert.match(premiumStyles, /\.zy-penpot-storefront \.zy-launch-home/u);
});

test('live category identity is exposed without changing category selection or order', () => {
  assert.match(homepage, /data-category-id=\{item\.category\.id\}/);
  assert.match(homepage, /data-category-id=\{item\.kind === 'live' \? item\.id : undefined\}/);
  assert.match(homepage, /orderByCategoryPriority\(categoryVisuals, item => item\.category\.id, LAUNCH_FEATURED_CATEGORY_IDS\)/);
  assert.match(homepage, /onSelectCategory\(item\.category\.id\)/);
});

test('collection color treatments use stable category IDs and preserve the two-column mobile grid', () => {
  assert.match(premiumStyles, /data-category-id='fashion'[\s\S]*linear-gradient\(135deg, #f97316/);
  assert.match(premiumStyles, /data-category-id='home-garden'[\s\S]*linear-gradient\(135deg, #2563eb/);
  assert.match(premiumStyles, /data-category-id='kids-toys'[\s\S]*linear-gradient\(135deg, #7c3aed/);
  assert.match(premiumStyles, /data-category-id='health-beauty'[\s\S]*linear-gradient\(135deg, #d9a441/);
  assert.match(premiumStyles, /@media \(max-width: 767px\)[\s\S]*zy-home-category-promo-grid[\s\S]*gap: 0\.7rem/);
});

test('homepage presentation does not add product, stock, cart or supplier behavior', () => {
  assert.doesNotMatch(premiumStyles, /StorefrontProductShelf|stock|checkout|supplier|firebase/iu);
});
