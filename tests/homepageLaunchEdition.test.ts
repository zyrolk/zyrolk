import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const shelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const trustStrip = readFileSync('src/components/HomepageTrustStrip.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('Sprint 75A composes only the four approved premium homepage surfaces', () => {
  assert.match(homepage, /zy-launch-home/);
  assert.match(homepage, /<HeroBanner/);
  assert.match(homepage, /zy-foundation-category-dock/);
  assert.equal((homepage.match(/<StorefrontProductShelf/g) || []).length, 5);
  assert.match(homepage, /<HomepageTrustStrip \/>/);
  assert.doesNotMatch(homepage, /review|testimonial|why choose|<Footer/iu);
});

test('premium shelf treatments retain every live App-level product projection', () => {
  for (const products of [
    'discountedProducts',
    'featuredProducts',
    'newArrivalProducts',
    'bestSellerProducts',
    'recommendedProducts',
  ]) {
    assert.match(homepage, new RegExp(`products=\\{${products}\\}`));
  }

  assert.match(app, /onSnapshot\(collection\(db, "products"\)/);
  assert.doesNotMatch(homepage, /firebase|firestore|mock product|sample product/iu);
  assert.doesNotMatch(shelf, /firebase|firestore|mock product|sample product/iu);
});

test('CMS hero behavior remains the source of homepage slides and actions', () => {
  assert.match(homepage, /settings=\{settings\}/);
  assert.match(hero, /settings\?\.heroBanners/);
  assert.match(hero, /configuredSlides\.map/);
  assert.match(hero, /normalizeSlideSpeed/);
  assert.match(hero, /onExploreProducts/);
  assert.match(hero, /onBrowseCategories/);
  assert.doesNotMatch(homepage, /heroSlides\s*=|const\s+slides\s*=/);
});

test('product shelves preserve the shared ProductCard commerce contract', () => {
  assert.equal((shelf.match(/<ProductCard/g) || []).length, 1);
  assert.match(shelf, /product=\{product\}/);
  assert.match(shelf, /onAddToCart=\{onAddToCart\}/);
  assert.match(shelf, /onToggleWishlist=\{onToggleWishlist\}/);
  assert.match(shelf, /onViewDetail=\{onViewDetail\}/);
  assert.match(shelf, /showWishlist=\{showWishlist\}/);
  assert.match(shelf, /settings=\{settings\}/);
  assert.doesNotMatch(homepage, /<ProductCard/);
});

test('trust strip uses factual service messages without changing a data contract', () => {
  for (const message of [
    'Cash on Delivery',
    'Islandwide Delivery',
    'Secure Checkout',
    'Local Support',
  ]) {
    assert.match(trustStrip, new RegExp(message));
  }

  assert.doesNotMatch(trustStrip, /firebase|firestore|api|warranty|guarantee/iu);
});

test('launch styling is homepage-scoped, responsive, animated, and motion-safe', () => {
  assert.match(styles, /Sprint 75A — Premium Launch homepage presentation/);
  assert.match(styles, /\.zy-launch-home \.zy-hero-v2-stage/);
  assert.match(styles, /\.zy-launch-home \.zy-foundation-category-dock/);
  assert.match(styles, /\.zy-launch-home \.zy-storefront-product-shelf/);
  assert.match(styles, /\.zy-launch-trust-grid/);
  assert.match(styles, /@keyframes zy-launch-section-in/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.zy-launch-home \.zy-foundation-category-rail/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*zy-launch-section-in/);
});
