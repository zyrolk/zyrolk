import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const modal = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const model = readFileSync('src/features/product-experience/productExperience.ts', 'utf8');
const related = readFileSync('src/features/product-experience/RelatedProductsRail.tsx', 'utf8');
const specifications = readFileSync('src/features/product-experience/ProductSpecificationsPanel.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('Sprint 76 preserves the App-level product and commerce contracts', () => {
  assert.match(app, /const liveSelectedProduct = selectedProduct \? \(storefrontProducts\.find/);
  assert.match(app, /product=\{liveSelectedProduct\}/);
  assert.match(app, /allProducts=\{activeProducts\}/);
  assert.match(app, /onAddToCart=\{handleAddToCart\}/);
  assert.match(app, /onToggleWishlist=\{handleToggleWishlist\}/);
  assert.match(app, /onBuyNow=\{handleBuyNow\}/);
  assert.match(app, /settings=\{settings\}/);
  assert.match(modal, /onBuyNow\(product, quantity\)/);
  assert.match(modal, /onAddToCart\(product, quantity\)/);
  assert.match(modal, /onToggleWishlist\(product\)/);
});

test('premium gallery retains live images while improving load, zoom, keyboard, and swipe behavior', () => {
  assert.match(modal, /buildProductGallery\(product\)/);
  assert.match(modal, /setIsMainImageLoading\(true\)/);
  assert.match(modal, /const image = new Image\(\)/);
  assert.match(modal, /image\.src = galleryImages\[index\]/);
  assert.match(modal, /onLoad=\{\(\) => setIsMainImageLoading\(false\)\}/);
  assert.match(modal, /fetchPriority="high"/);
  assert.match(modal, /zy-product-experience-image-loading/);
  assert.match(modal, /role="button"[\s\S]*tabIndex=\{0\}/);
  assert.match(modal, /nextGalleryIndexForKey/);
  assert.match(modal, /zy-product-experience-lightbox/);
  assert.match(modal, /lightboxZoom === 1[\s\S]*handleTouchStart/);
  assert.match(modal, /lightboxZoom === 1[\s\S]*handleTouchEnd/);
});

test('product information continues to render existing pricing, inventory, category, and specification data', () => {
  assert.match(modal, /product\.category\.replace/);
  assert.match(modal, /product\.stock <= 5/);
  assert.match(modal, /formatPrice\(product\.price\)/);
  assert.match(modal, /product\.originalPrice > product\.price/);
  assert.match(modal, /product\.description/);
  assert.match(modal, /groupProductSpecifications\(product\?\.specs\)/);
  assert.match(modal, /<ProductSpecificationsPanel groups=\{specificationGroups\}/);
  assert.match(specifications, /groups\.map/);
  assert.match(specifications, /group\.entries\.map/);
});

test('premium purchase section retains delivery, secure shopping, WhatsApp, cart, and buy actions', () => {
  assert.match(modal, /zy-product-experience-purchase/);
  assert.match(modal, /Cash on Delivery/);
  assert.match(modal, /Island-wide Delivery/);
  assert.match(modal, /Secure Checkout/);
  assert.match(modal, /Customer Support/);
  assert.match(modal, /settings\?\.freeDeliveryMin/);
  assert.match(modal, /handleWhatsAppCheckout/);
  assert.match(modal, /handleWhatsAppEnquiry/);
  assert.match(modal, /Order on WhatsApp/);
  assert.match(modal, /Add to Cart/);
  assert.match(modal, /Buy Now/);
});

test('mobile sticky purchase bar reuses the existing quantity and commerce handlers', () => {
  assert.match(modal, /showStickyBar && !isLightboxOpen/);
  assert.match(modal, /zy-product-experience-mobile-bar/);
  assert.match(modal, /md:hidden/);
  assert.match(modal, /Qty \{quantity\}/);
  assert.match(modal, /onClick=\{handleAddToCart\}/);
  assert.match(modal, /onClick=\{\(\) => onBuyNow\(product, quantity\)\}/);
  assert.match(modal, /onClick=\{handleWhatsAppEnquiry\}/);
});

test('related-products presentation consumes the unchanged deterministic ranking result', () => {
  assert.match(modal, /selectRelatedProducts\(product, allProducts\)/);
  assert.match(modal, /products=\{relatedItems\}/);
  assert.match(model, /Number\(b\.sameCategory\) - Number\(a\.sameCategory\)/);
  assert.match(model, /Number\(b\.sameBrand\) - Number\(a\.sameBrand\)/);
  assert.match(model, /a\.priceDistance - b\.priceDistance/);
  assert.match(related, /products\.map/);
  assert.match(related, /onSelect\(item\)/);
  assert.match(related, /item\.originalPrice > item\.price/);
  assert.doesNotMatch(related, /firebase|firestore|collection\(|onSnapshot\(|\.sort\(|\.filter\(/iu);
});

test('Sprint 76 styling is responsive, swipe-friendly, premium, and motion-safe', () => {
  assert.match(styles, /Sprint 76 — Premium product experience/);
  assert.match(styles, /\.zy-product-experience-gallery\s*\{[\s\S]*touch-action: pan-y/);
  assert.match(styles, /\.zy-product-experience-purchase\s*\{[\s\S]*backdrop-filter: blur/);
  assert.match(styles, /\.zy-related-products-rail\s*\{[\s\S]*overscroll-behavior-inline: contain/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.zy-product-experience-mobile-bar/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.zy-related-product-card[\s\S]*min-width:/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.zy-product-experience-image-loading/);
});

test('Sprint 76 does not replace or duplicate the shared ProductCard', () => {
  assert.doesNotMatch(modal, /<ProductCard/);
  assert.doesNotMatch(related, /<ProductCard/);
  assert.match(productCard, /onAddToCart/);
  assert.match(productCard, /onToggleWishlist/);
  assert.match(productCard, /onViewDetail/);
});
