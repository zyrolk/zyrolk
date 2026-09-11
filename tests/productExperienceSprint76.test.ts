import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';

const app = readFileSync('src/App.tsx', 'utf8');
const modal = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const model = readFileSync('src/features/product-experience/productExperience.ts', 'utf8');
const related = readFileSync('src/features/product-experience/RelatedProductsRail.tsx', 'utf8');
const specifications = readFileSync('src/features/product-experience/ProductSpecificationsPanel.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');
const resolverStart = app.indexOf('export function resolveSelectedProduct');
const resolverEnd = app.indexOf('const selectFilteredStorefrontProducts');
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, 'selected-product resolver must remain available');
const resolverModule = { exports: {} as {
  resolveSelectedProduct: (selectedProduct: ProductFixture | null, activeProducts: readonly ProductFixture[], readiness: ReadinessFixture) => {
    product: ProductFixture | null;
    shouldClose: boolean;
  };
} };
const resolverSource = `
const isProductExplicitlyActive = (value) => value === true;
${app.slice(resolverStart, resolverEnd)}
`;
const resolverCode = transformSync(resolverSource, { loader: 'tsx', format: 'cjs' }).code;
new Function('module', 'exports', resolverCode)(resolverModule, resolverModule.exports);
const { resolveSelectedProduct } = resolverModule.exports;

type ProductFixture = {
  id: string;
  isActive: boolean;
  price: number;
  stock: number;
};

type ReadinessFixture = {
  catalogFullyLoaded: boolean;
  loading: boolean;
  loadingMoreProducts: boolean;
  isResolvingRoutedProduct: boolean;
  storefrontDataError: string | null;
};

const productFixture = (id: string, overrides: Partial<ProductFixture> = {}): ProductFixture => ({
  id,
  isActive: true,
  price: 100,
  stock: 5,
  ...overrides,
});

const completeCatalogue = (): ReadinessFixture => ({
  catalogFullyLoaded: true,
  loading: false,
  loadingMoreProducts: false,
  isResolvingRoutedProduct: false,
  storefrontDataError: null,
});

test('Sprint 76 preserves the App-level product and commerce contracts', () => {
  assert.match(app, /resolveSelectedProduct\(selectedProduct, activeProducts/);
  assert.match(app, /if \(!selectedProductResolution\.shouldClose\) return;/);
  assert.match(app, /closeProductDetail\(\);/);
  assert.match(app, /if \(blocksProducts\) setCatalogFullyLoaded\(false\);[\s\S]*if \(blocksProducts\) setLoading\(false\);/);
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

test('selected-product reconciliation is readiness-gated, live-first, and closes only on authoritative absence', () => {
  const stale = productFixture('p1', { price: 100, stock: 5 });
  const live = productFixture('p1', { price: 125, stock: 2 });

  const incomplete = resolveSelectedProduct(stale, [], {
    ...completeCatalogue(),
    catalogFullyLoaded: false,
  });
  assert.equal(incomplete.product, stale);
  assert.equal(incomplete.shouldClose, false);

  const loading = resolveSelectedProduct(stale, [], {
    ...completeCatalogue(),
    loading: true,
  });
  assert.equal(loading.product, stale);
  assert.equal(loading.shouldClose, false);

  const paginating = resolveSelectedProduct(stale, [], {
    ...completeCatalogue(),
    loadingMoreProducts: true,
  });
  assert.equal(paginating.product, stale);
  assert.equal(paginating.shouldClose, false);

  const hydrating = resolveSelectedProduct(stale, [], {
    ...completeCatalogue(),
    isResolvingRoutedProduct: true,
  });
  assert.equal(hydrating.product, stale);
  assert.equal(hydrating.shouldClose, false);

  const listenerError = resolveSelectedProduct(stale, [], {
    ...completeCatalogue(),
    storefrontDataError: 'catalogue refresh failed',
  });
  assert.equal(listenerError.product, stale);
  assert.equal(listenerError.shouldClose, false);

  const refreshed = resolveSelectedProduct(stale, [live], completeCatalogue());
  assert.equal(refreshed.product, live);
  assert.equal(refreshed.product?.price, 125);
  assert.equal(refreshed.product?.stock, 2);
  assert.equal(refreshed.shouldClose, false);

  const absent = resolveSelectedProduct(stale, [], completeCatalogue());
  assert.equal(absent.product, null);
  assert.equal(absent.shouldClose, true);

  const inactive = resolveSelectedProduct(stale, [productFixture('p1', { isActive: false })], completeCatalogue());
  assert.equal(inactive.product, null);
  assert.equal(inactive.shouldClose, true);

  const recoveredLive = resolveSelectedProduct(stale, [live], {
    ...completeCatalogue(),
    storefrontDataError: null,
  });
  assert.equal(recoveredLive.product, live);
  assert.equal(recoveredLive.shouldClose, false);

  const recoveredAbsent = resolveSelectedProduct(stale, [], {
    ...completeCatalogue(),
    storefrontDataError: null,
  });
  assert.equal(recoveredAbsent.product, null);
  assert.equal(recoveredAbsent.shouldClose, true);
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
  assert.match(modal, /handleWhatsAppOrderAssistance/);
  assert.match(modal, /handleWhatsAppEnquiry/);
  assert.match(modal, /Need help ordering\? Chat on WhatsApp/);
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
