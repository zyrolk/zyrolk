import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const shelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('Sprint 74 composes all five homepage sections from the generic storefront shelf', () => {
  assert.equal((homepage.match(/<StorefrontProductShelf/g) || []).length, 5);
  for (const key of ['flashDeals', 'featured', 'newArrivals', 'bestSellers', 'recommended']) {
    assert.match(homepage, new RegExp(`title=\\{homepageSections\\.${key}\\.title\\}`));
    assert.match(homepage, new RegExp(`homepageSections\\.${key}\\.enabled`));
  }
  assert.doesNotMatch(homepage, /<ProductCard/);
});

test('shelf product selection stays with the live App-level product projections', () => {
  assert.match(app, /onSnapshot\(collection\(db, "products"\)/);
  assert.match(app, /activeProducts\.filter\(product => product\.isNew\)\.slice\(0, 8\)/);
  assert.match(app, /activeProducts\.filter\(product => product\.isBestSeller\)\.slice\(0, 8\)/);
  assert.match(app, /featuredProducts\.filter\(product => !dealIds\.has\(product\.id\)\)\.slice\(0, 8\)/);
  assert.match(app, /typeof product\.originalPrice === 'number'/);
  assert.match(app, /originalPrice > product\.price/);
  assert.doesNotMatch(shelf, /firebase|firestore|isNew|isFeatured|isBestSeller|originalPrice >|\.filter\(/iu);
});

test('generic shelf receives content, state, actions, and commerce handlers through props', () => {
  for (const prop of [
    'title',
    'subtitle',
    'products',
    'loading',
    'emptyState',
    'viewAllAction',
    'onAddToCart',
    'onToggleWishlist',
    'onViewDetail',
  ]) {
    assert.match(shelf, new RegExp(`${prop}\\??:`));
  }
  assert.match(shelf, /products\.map\(product/);
  assert.equal((shelf.match(/<ProductCard/g) || []).length, 1);
  assert.match(shelf, /viewAllAction\.onClick/);
  assert.match(shelf, /wishlistProductIds\.has\(product\.id\)/);
});

test('generic shelf presents honest loading and empty states without merchandise fillers', () => {
  assert.match(shelf, /SHELF_SKELETONS/);
  assert.match(shelf, /aria-busy="true"/);
  assert.match(shelf, /products\.length > 0/);
  assert.match(shelf, /emptyState\.title/);
  assert.match(shelf, /emptyState\.description/);
  assert.doesNotMatch(shelf, /fake|demo|sample product|placeholder merchandise/iu);
  assert.doesNotMatch(homepage, /fake|demo|sample product|placeholder merchandise/iu);
});

test('shared shelf layout provides four-column desktop, adaptive tablet, and mobile snap scrolling', () => {
  assert.match(styles, /\.zy-storefront-product-shelf-grid\s*\{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.zy-storefront-product-shelf-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 899px\)[\s\S]*\.zy-storefront-product-shelf-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.zy-storefront-product-shelf-grid \{[\s\S]*overflow-x: auto[\s\S]*scroll-snap-type: x mandatory/);
  assert.match(styles, /\.zy-storefront-product-shelf-item,[\s\S]*scroll-snap-align: start/);
  assert.match(styles, /\.zy-foundation-shelf-stack\s*\{[\s\S]*gap: clamp\(3rem, 6vw, 5rem\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.zy-storefront-product-skeleton[\s\S]*animation: none/);
});
