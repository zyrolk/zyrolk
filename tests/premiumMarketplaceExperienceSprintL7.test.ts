import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const main = readFileSync('src/main.tsx', 'utf8');
const controller = readFileSync('src/components/StorefrontMotionController.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const productDetail = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const floatingSupport = readFileSync('src/components/FloatingWhatsApp.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontL7.css', 'utf8');

test('Sprint L7 uses an isolated final presentation layer', () => {
  assert.match(main, /import '\.\/styles\/storefrontL6\.css';\s+import '\.\/styles\/storefrontL7\.css';/);
  assert.doesNotMatch(styles, /firebase|firestore|checkout|collection\(|onSnapshot/u);
  assert.doesNotMatch(controller, /firebase|firestore|fetch\(|localStorage/u);
});

test('scroll reveals use IntersectionObserver with a reduced-motion fallback', () => {
  assert.match(app, /StorefrontMotionController/);
  assert.match(controller, /IntersectionObserver/);
  assert.match(controller, /prefers-reduced-motion: reduce/);
  assert.match(controller, /data-zy-reveal/);
  assert.match(styles, /data-zy-reveal-state="pending"/);
  assert.match(styles, /data-zy-reveal-state="visible"/);
});

test('hero, category, and product discovery receive premium motion states', () => {
  assert.match(hero, /data-zy-reveal/);
  assert.match(productCard, /data-zy-reveal/);
  assert.match(styles, /zy-l7-hero-copy/);
  assert.match(styles, /zy-foundation-category-tile:hover \.zy-foundation-category-image/);
  assert.match(styles, /zy-l7-product-image/);
});

test('search and mobile navigation animate open and closed accessibly', () => {
  assert.match(navbar, /AnimatePresence/);
  assert.match(navbar, /exit=\{prefersReducedMotion/);
  assert.match(navbar, /role="listbox"/);
  assert.match(mobileNavigation, /AnimatePresence/);
  assert.match(mobileNavigation, /aria-modal="true"/);
  assert.match(mobileNavigation, /prefersReducedMotion/);
  assert.match(styles, /\.zy-market-header \.zy-search-submit \{\s+position: absolute/);
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});

test('commerce feedback preserves existing handlers and adds visual response', () => {
  assert.match(productCard, /onAddToCart\(product\)/);
  assert.match(productCard, /onToggleWishlist\(product\)/);
  assert.match(productCard, /is-added/);
  assert.match(productCard, /is-wishlisted/);
  assert.match(styles, /zy-l7-cart-success/);
  assert.match(styles, /zy-l7-wishlist/);
  assert.match(styles, /zy-l7-ripple/);
});

test('gallery, quantity, and sticky purchase transitions remain gesture friendly', () => {
  assert.match(productDetail, /onTouchStart=\{handleTouchStart\}/);
  assert.match(productDetail, /lightboxZoom/);
  assert.match(productDetail, /zy-product-experience-quantity-value/);
  assert.match(productDetail, /prefersReducedMotion \? \{ opacity: 1 \}/);
  assert.match(styles, /touch-action: pan-y pinch-zoom/);
  assert.match(styles, /scroll-snap-type: x proximity/);
  assert.match(styles, /zy-product-experience-mobile-bar/);
});

test('loading, empty, filter, and safe-area polish avoids layout-changing animation', () => {
  assert.match(styles, /zy-l7-shimmer/);
  assert.match(styles, /zy-l7-empty-float/);
  assert.match(styles, /\.zy-catalog-page \.zy-results-toolbar \{\s+position: sticky/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /@media \(max-width: 359px\)/);
  assert.doesNotMatch(styles, /@keyframes[^}]+(?:width|height|margin|padding):/su);
});

test('motion remains accessible and performance conscious', () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /will-change: opacity, transform/);
  assert.match(styles, /contain: layout paint/);
  assert.match(floatingSupport, /zy-floating-whatsapp/);
  assert.match(floatingSupport, /left 240ms/);
});
