import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  catalogStatusFromProductPage,
  shouldShowCatalogFallback,
} from '../src/services/storefront/catalogState';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');

test('catalog state distinguishes loading, ready, true empty, error, and timeout', () => {
  assert.equal(shouldShowCatalogFallback('loading', true, false), false);
  assert.equal(catalogStatusFromProductPage(3), 'ready');
  assert.equal(shouldShowCatalogFallback('ready', false, true), false);
  assert.equal(catalogStatusFromProductPage(0), 'empty');
  assert.equal(shouldShowCatalogFallback('empty', false, false), true);
  assert.equal(shouldShowCatalogFallback('error', false, false), true);
  assert.equal(shouldShowCatalogFallback('timeout', false, false), true);
  assert.equal(shouldShowCatalogFallback('error', false, true), false);
});

test('App records catalog success, product failure, and timeout without changing product authority', () => {
  assert.match(app, /useState<StorefrontCatalogStatus>\('loading'\)/u);
  assert.match(app, /setCatalogStatus\(current => current === 'loading' \? 'timeout' : current\)/u);
  assert.match(app, /setCatalogStatus\('error'\)/u);
  assert.match(app, /setCatalogStatus\(catalogStatusFromProductPage\(page\.products\.length\)\)/u);
  assert.match(app, /catalogStatus=\{catalogStatus\}/u);
  assert.doesNotMatch(app, /setProducts\(.*fallback|mock|sample/iu);
});

test('homepage shows only a compact customer-safe fallback for confirmed non-ready catalog states', () => {
  assert.match(homepage, /shouldShowCatalogFallback\(catalogStatus, loading, hasAnyLiveShelfProducts\)/u);
  assert.match(homepage, /Products are taking a little longer to load/u);
  assert.match(homepage, /Products are being prepared/u);
  assert.match(homepage, /Browse categories while we reconnect to the live catalogue/u);
  assert.match(homepage, /onClick=\{onBrowseCategories\}/u);
  assert.match(homepage, /role=\{catalogFallbackKind === 'empty' \? 'status' : 'alert'\}/u);
  assert.match(homepage, /if \(loading \|\| hasLiveProducts\)/u);
  assert.match(homepage, /const hasAnyLiveShelfProducts/u);
});

test('homepage order keeps catalog fallback at the shelf boundary', () => {
  const promo = homepage.indexOf('zy-home-secondary-promos');
  const fallback = homepage.indexOf('zy-home-catalog-state');
  const shelves = homepage.indexOf('zy-foundation-shelf-stack');
  assert.ok(promo >= 0 && fallback > promo && shelves > fallback);
  assert.match(homepage, /<HomepageDealStrip/u);
  assert.match(homepage, /zy-home-secondary-promos/u);
});
