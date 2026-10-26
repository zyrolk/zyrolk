import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const bottomNav = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
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

test('homepage shortcuts use the approved five-category presentation priority', () => {
  assert.match(homepage, /data-category-id=\{item\.category\.id\}/);
  assert.match(homepage, /data-category-id=\{item\.kind === 'live' \? item\.id : undefined\}/);
  assert.match(homepage, /HOMEPAGE_CATEGORY_SHORTCUT_IDS/);
  assert.match(homepage, /categoryVisuals\.filter\(item => HOMEPAGE_CATEGORY_SHORTCUT_IDS/);
  assert.match(homepage, /onSelectCategory\(item\.category\.id\)/);
  assert.match(homepage, /Browse all categories/);
});

test('homepage collections use the approved identity order without changing routes', () => {
  assert.match(homepage, /HOMEPAGE_COLLECTION_CATEGORY_IDS/);
  assert.match(homepage, /categoryVisuals\.filter\(item => HOMEPAGE_COLLECTION_CATEGORY_IDS/);
  assert.match(homepage, /onSelectCategory\(item\.category\.id\)/);
});

test('collection color treatments use stable category IDs and preserve the two-column mobile grid', () => {
  assert.match(premiumStyles, /data-category-id='fashion'[\s\S]*linear-gradient\(135deg, #f97316/);
  assert.match(premiumStyles, /data-category-id='home-garden'[\s\S]*linear-gradient\(135deg, #2563eb/);
  assert.match(premiumStyles, /data-category-id='kids-toys'[\s\S]*linear-gradient\(135deg, #7c3aed/);
  assert.match(premiumStyles, /data-category-id='baby-kids'[\s\S]*linear-gradient\(135deg, #7c3aed/);
  assert.match(premiumStyles, /data-category-id='health-beauty'[\s\S]*linear-gradient\(135deg, #d9a441/);
  assert.match(premiumStyles, /@media \(max-width: 767px\)[\s\S]*zy-home-category-promo-grid[\s\S]*gap: 0\.7rem/);
});

test('mobile category shortcuts fit the approved five-item presentation', () => {
  assert.match(premiumStyles, /Homepage finalization: fit the five approved mobile shortcuts/);
  assert.match(premiumStyles, /Homepage finalization: fit the five approved mobile shortcuts[\s\S]*@media \(max-width: 767px\)[\s\S]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(premiumStyles, /Homepage finalization: fit the five approved mobile shortcuts[\s\S]*\.zy-foundation-category-all\s*\{\s*display: none/);
  assert.match(premiumStyles, /Homepage finalization: fit the five approved mobile shortcuts[\s\S]*overflow-wrap: anywhere/);
});

test('mobile navigation remains full-width and safe-area aware', () => {
  assert.match(bottomNav, /zy-bottom-dock fixed left-3 right-3/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-bottom-dock\s*\{[\s\S]*bottom: 0/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-mobile-dock\s*\{[\s\S]*background: rgba\(255, 255, 255, 0\.98\)/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-mobile-dock\s*\{[\s\S]*padding: 0\.35rem 0\.4rem env\(safe-area-inset-bottom\)/);
});

test('homepage presentation does not add product, stock, cart or supplier behavior', () => {
  assert.doesNotMatch(premiumStyles, /StorefrontProductShelf|stock|checkout|supplier|firebase/iu);
});
