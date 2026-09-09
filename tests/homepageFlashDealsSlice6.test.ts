import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const shelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice6Styles = styles.slice(
  styles.indexOf('/* Homepage redesign Slice 6'),
  styles.indexOf('/* Homepage redesign Slice 7'),
);

test('Slice 6 keeps Flash Deals on the existing explicit discounted-product projection', () => {
  assert.match(homepage, /id: 'homepage-flash-deals'[\s\S]*?tone: 'deals'/);
  assert.match(homepage, /tone: 'deals'[\s\S]*?products: discountedProducts/);
  assert.match(homepage, /title: 'No live deals right now'/);
  assert.match(homepage, /Products with a genuine active discount will appear here automatically\./);

  const discountedProjection = app.slice(app.indexOf('const discountedProducts = useMemo('), app.indexOf('const trendingProducts = useMemo('));
  assert.match(discountedProjection, /Boolean\(product\.discount && product\.discount > 0\)/);
  assert.match(discountedProjection, /typeof product\.originalPrice === 'number'/);
  assert.match(discountedProjection, /product\.originalPrice > product\.price/);
  assert.doesNotMatch(discountedProjection, /marketPrice|comparePrice|supplier/i);
});

test('Slice 6 preserves the shared card commerce and product interaction contract', () => {
  assert.match(shelf, /<ProductCard[\s\S]*product=\{product\}/);
  assert.match(shelf, /onAddToCart=\{onAddToCart\}/);
  assert.match(shelf, /onToggleWishlist=\{onToggleWishlist\}/);
  assert.match(shelf, /onViewDetail=\{onViewDetail\}/);
  assert.match(shelf, /settings=\{settings\}/);
  assert.match(homepage, /onClick: onExploreProducts/);
});

test('Slice 6 scopes the deals treatment and keeps the legitimate empty state', () => {
  assert.match(slice6Styles, /zy-storefront-product-shelf\.is-deals/);
  assert.match(slice6Styles, /zy-product-card[\s\S]*height: 31\.5rem/);
  assert.match(slice6Styles, /zy-storefront-product-skeleton[\s\S]*height: 31\.5rem/);
  assert.match(slice6Styles, /grid-template-columns: repeat\(5/);
  assert.match(slice6Styles, /@media \(max-width: 767px\)[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(slice6Styles, /zy-storefront-product-shelf-empty/);
  assert.doesNotMatch(slice6Styles, /up to \d+%|fake|mock|sample|limited[- ]time|save \d+/iu);
});

test('Slice 6 leaves non-deal shelf presentation selectors untouched', () => {
  assert.doesNotMatch(slice6Styles, /zy-storefront-product-shelf\.is-(featured|new|best-seller|recommended)/);
  assert.doesNotMatch(slice6Styles, /supplier|marketPrice|comparePrice|checkout|firebase/i);
});
