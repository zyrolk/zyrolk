import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const productShelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('Product Card V2 remains the single shared storefront product card', () => {
  assert.match(app, /import ProductCard from '\.\/components\/ProductCard'/);
  assert.match(homepage, /import StorefrontProductShelf from '\.\/StorefrontProductShelf'/);
  assert.match(productShelf, /import ProductCard from '\.\/ProductCard'/);
  assert.match(app, /<ProductCard/g);
  assert.match(homepage, /<StorefrontProductShelf/g);
  assert.match(productShelf, /<ProductCard/);
  assert.doesNotMatch(app, /ProductCardV2|PremiumProductCard|DealProductCard/);
  assert.doesNotMatch(homepage, /ProductCardV2|PremiumProductCard|DealProductCard/);
  assert.doesNotMatch(productShelf, /ProductCardV2|PremiumProductCard|DealProductCard/);
});

test('Product Card V2 preserves every existing interaction and commerce flow', () => {
  assert.match(productCard, /onToggleWishlist\(product\)/);
  assert.match(productCard, /onViewDetail\(product\)/);
  assert.match(productCard, /onAddToCart\(product\)/);
  assert.match(productCard, /handleWhatsAppQuickBuy/);
  assert.match(productCard, /handleWhatsAppEnquiry/);
  assert.match(productCard, /window\.open\(`https:\/\/wa\.me\/\$\{waNumber\}\?text=\$\{message\}`/);
  assert.match(productCard, /PRODUCT_IMAGE_FALLBACK/);
  assert.match(productCard, /product\.reviewsCount > 0/);
  assert.match(productCard, /product\.stock <= 0/);
  assert.match(productCard, /product\.originalPrice && product\.originalPrice > product\.price/);
  assert.doesNotMatch(productCard, /demo|sample rating|fake stock/iu);
});

test('Product Card V2 has fixed geometry, contained imagery, and aligned commerce rows', () => {
  assert.match(styles, /\.zy-product-card\s*\{[\s\S]*height: 40rem;[\s\S]*grid-template-rows: 56% 44%/);
  assert.match(styles, /\.zy-product-card-image\s*\{[\s\S]*aspect-ratio: 1;[\s\S]*object-fit: contain/);
  assert.match(styles, /\.zy-product-card-info\s*\{[\s\S]*grid-template-rows: 1rem 3rem 1\.25rem/);
  assert.match(styles, /\.zy-product-card-title button\s*\{[\s\S]*-webkit-line-clamp: 2/);
  assert.match(styles, /\.zy-product-card-commerce\s*\{[\s\S]*min-height: 4\.35rem/);
  assert.match(styles, /\.zy-product-card-actions,[\s\S]*height: 3rem/);
});

test('Product Card V2 keeps badges separated and Quick View accessible on touch and keyboard', () => {
  assert.match(styles, /\.zy-product-card-badges\s*\{[\s\S]*flex-direction: column;[\s\S]*gap: 0\.35rem/);
  assert.match(styles, /\.zy-product-card-wishlist\s*\{[\s\S]*right: 1rem/);
  assert.match(styles, /\.zy-product-quick-view\s*\{[\s\S]*display: inline-flex;[\s\S]*min-height: 3rem/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.zy-product-quick-view\s*\{[\s\S]*opacity: 0/);
  assert.match(styles, /\.zy-product-quick-view:focus-visible[\s\S]*opacity: 1/);
  assert.match(productCard, /aria-label=\{`Quick view \$\{product\.name\}`\}/);
  assert.match(productCard, /aria-pressed=\{isWishlisted\}/);
  assert.match(productCard, /aria-live="polite"/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.zy-product-card-image/);
});
