import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const main = readFileSync('src/main.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const productDetail = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontL6.css', 'utf8');

test('Sprint L6 is isolated to a final storefront presentation layer', () => {
  assert.match(main, /import '\.\/styles\/storefrontL6\.css'/);
  assert.match(app, /zy-l6-shell/);
  assert.match(app, /zy-l6-main/);
  assert.doesNotMatch(styles, /from ['"]firebase|onSnapshot|collection\(/u);
});

test('premium mobile breakpoints cover compact and tablet storefront layouts', () => {
  assert.match(styles, /@media \(max-width: 359px\)/);
  assert.match(styles, /@media \(max-width: 479px\)/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1023px\)/);
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});

test('product card polish preserves all established customer actions', () => {
  assert.match(productCard, /onAddToCart\(product\)/);
  assert.match(productCard, /onToggleWishlist\(product\)/);
  assert.match(productCard, /onViewDetail\(product\)/);
  assert.match(productCard, /handleWhatsAppQuickBuy/);
  assert.match(productCard, /handleWhatsAppEnquiry/);
  assert.match(productCard, /isImageLoaded/);
  assert.match(styles, /\.zy-product-card-image\.is-loading/);
  assert.match(styles, /\.zy-product-card\.is-added/);
  assert.match(styles, /\.zy-product-card\.is-wishlisted/);
});

test('search and navigation polish keeps keyboard and screen-reader contracts', () => {
  assert.match(navbar, /role="combobox"/);
  assert.match(navbar, /aria-autocomplete="list"/);
  assert.match(navbar, /aria-activedescendant/);
  assert.match(navbar, /zy-search-suggestions/);
  assert.match(mobileNavigation, /aria-label="Mobile storefront navigation"/);
  assert.match(mobileNavigation, /aria-current=/);
  assert.match(mobileNavigation, /zy-mobile-tab/);
});

test('product detail polish reuses the existing gallery and commerce implementation', () => {
  assert.match(productDetail, /zy-product-experience-gallery/);
  assert.match(productDetail, /zy-product-experience-mobile-bar/);
  assert.match(productDetail, /onClick=\{handleAddToCart\}/);
  assert.match(productDetail, /onBuyNow\(product, quantity\)/);
  assert.match(styles, /\.zy-product-experience-gallery/);
  assert.match(styles, /\.zy-product-experience-mobile-bar/);
});

test('motion is GPU-friendly, reduced-motion aware, and loading states remain graceful', () => {
  assert.match(styles, /translate3d/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /animation-duration: 0\.01ms !important/);
  assert.match(styles, /@keyframes zy-l6-shimmer/);
  assert.match(styles, /content-visibility: auto/);
});

test('accessibility retains visible focus and high-contrast support', () => {
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /touch-action: manipulation/);
  assert.match(productCard, /aria-pressed=\{isWishlisted\}/);
  assert.match(productDetail, /role="dialog"/);
});
