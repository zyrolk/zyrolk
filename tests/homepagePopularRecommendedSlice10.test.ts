import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const shelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice10Styles = styles.slice(styles.indexOf('/* Homepage redesign Slice 10'));

test('Slice 10 keeps Popular / Recommended on the existing active-catalog projection', () => {
  const projection = app.slice(
    app.indexOf('const recommendedProducts = useMemo('),
    app.indexOf('const homepageLatestProducts = useMemo('),
  );

  assert.match(homepage, /id: 'homepage-recommended-products'[\s\S]*?tone: 'recommended'/);
  assert.match(homepage, /products: recommendedProducts/);
  assert.match(projection, /activeProducts\.filter\(product => !usedIds\.has\(product\.id\)\)\.slice\(0, 8\)/);
  assert.match(projection, /discountedProducts|trendingProducts/);
  assert.doesNotMatch(projection, /salesCount|popularityScore|rating|reviewCount|fake|mock|sample/iu);
});

test('Slice 10 preserves the shared shelf commerce handlers and honest low-data state', () => {
  assert.match(homepage, /id: 'homepage-recommended-products'[\s\S]*?eyebrow: 'Explore more'/);
  assert.match(homepage, /onBrowse=\{onExploreProducts\}/);
  assert.match(homepage, /More products are being refreshed/);
  assert.match(shelf, /<ProductCard[\s\S]*product=\{product\}/);
  assert.match(shelf, /onAddToCart=\{onAddToCart\}/);
  assert.match(shelf, /onToggleWishlist=\{onToggleWishlist\}/);
  assert.match(shelf, /onViewDetail=\{onViewDetail\}/);
});

test('Slice 10 scopes a dense five-column desktop and two-column mobile treatment', () => {
  assert.match(styles, /Slice 10: compact Popular \/ Recommended discovery shelf/);
  assert.match(slice10Styles, /zy-storefront-product-shelf\.is-recommended/);
  assert.match(slice10Styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(slice10Styles, /zy-product-card[\s\S]*height: 30\.5rem/);
  assert.match(slice10Styles, /@media \(max-width: 767px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(slice10Styles, /@media \(max-width: 389px\)/);
  assert.match(slice10Styles, /zy-storefront-product-shelf-empty[\s\S]*min-height: 6\.25rem/);
  assert.doesNotMatch(slice10Styles, /\.is-deals|\.is-featured|\.is-new|\.is-best-seller|marketPrice|comparePrice|supplier|checkout|firebase|discount/iu);
});
