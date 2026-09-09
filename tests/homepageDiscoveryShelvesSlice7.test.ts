import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const shelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice7Styles = styles.slice(
  styles.indexOf('/* Homepage redesign Slice 7'),
  styles.indexOf('/* Homepage redesign Slice 8'),
);

test('Slice 7 preserves live Featured, New Arrivals and Best Sellers projections', () => {
  assert.match(app, /const featuredProducts = useMemo\([\s\S]*?activeProducts\.filter\(product => product\.isFeatured\)/);
  assert.match(app, /const newArrivalProducts = useMemo\([\s\S]*?activeProducts\.filter\(product => product\.isNew\)\.slice\(0, 8\)/);
  assert.match(app, /const bestSellerProducts = useMemo\([\s\S]*?activeProducts\.filter\(product => product\.isBestSeller\)\.slice\(0, 8\)/);
  assert.doesNotMatch(app, /featuredProducts\.push|newArrivalProducts\.push|bestSellerProducts\.push|mock|sample product/iu);
});

test('Slice 7 keeps the existing shelf IDs, tones, ordering, and View All handlers', () => {
  for (const [id, tone, products] of [
    ['homepage-featured-products', 'featured', 'featuredProducts'],
    ['homepage-new-arrivals', 'new', 'newArrivalProducts'],
    ['homepage-best-sellers', 'best-seller', 'bestSellerProducts'],
  ]) {
    assert.match(homepage, new RegExp(`id: '${id}'[\\s\\S]*?tone: '${tone}'[\\s\\S]*?products: ${products}`));
  }
  assert.ok(homepage.indexOf("id: 'homepage-new-arrivals'") < homepage.indexOf("id: 'homepage-featured-products'"));
  assert.ok(homepage.indexOf("id: 'homepage-featured-products'") < homepage.indexOf("id: 'homepage-best-sellers'"));
  assert.match(homepage, /homepageSections\.featured\.enabled/);
  assert.match(homepage, /homepageSections\.newArrivals\.enabled/);
  assert.match(homepage, /homepageSections\.bestSellers\.enabled/);
  assert.equal((homepage.match(/viewAllAction=\{\{ label: 'View all', onClick: onExploreProducts/g) || []).length, 1);
});

test('Slice 7 keeps shared ProductCard interactions and honest low-data states', () => {
  assert.equal((shelf.match(/<ProductCard/g) || []).length, 1);
  assert.match(shelf, /onAddToCart=\{onAddToCart\}/);
  assert.match(shelf, /onToggleWishlist=\{onToggleWishlist\}/);
  assert.match(shelf, /onViewDetail=\{onViewDetail\}/);
  assert.match(homepage, /title: 'No featured products right now'/);
  assert.match(homepage, /title: 'No new arrivals right now'/);
  assert.match(homepage, /title: 'No best sellers right now'/);
  assert.doesNotMatch(homepage, /sales count|trending score|fake|demo|sample product/iu);
});

test('Slice 7 scopes compact discovery styling without touching deals or recommended shelves', () => {
  assert.match(slice7Styles, /zy-storefront-product-shelf:is\(\.is-featured, \.is-new, \.is-best-seller\)/);
  assert.match(slice7Styles, /zy-product-card[\s\S]*height: 30\.5rem/);
  assert.match(slice7Styles, /zy-storefront-product-skeleton[\s\S]*height: 30\.5rem/);
  assert.match(slice7Styles, /grid-template-columns: repeat\(5/);
  assert.match(slice7Styles, /@media \(max-width: 767px\)[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(slice7Styles, /zy-storefront-product-shelf-empty[\s\S]*min-height: 6\.25rem/);
  assert.doesNotMatch(slice7Styles, /\.is-deals|\.is-recommended|marketPrice|comparePrice|supplier|checkout|firebase/i);
});
