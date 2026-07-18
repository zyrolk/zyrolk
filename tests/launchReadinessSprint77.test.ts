import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import { Product, WebsiteSettings } from '../src/types';

const app = readFileSync('src/App.tsx', 'utf8');
const seoComponent = readFileSync('src/components/StorefrontSeo.tsx', 'utf8');
const notFound = readFileSync('src/components/StorefrontNotFound.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const relatedProducts = readFileSync('src/features/product-experience/RelatedProductsRail.tsx', 'utf8');
const footer = readFileSync('src/components/Footer.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');
const html = readFileSync('index.html', 'utf8');
const manifest = readFileSync('public/manifest.json', 'utf8');
const viteConfig = readFileSync('vite.config.ts', 'utf8');

const settings: WebsiteSettings = {
  storeName: 'Zyro.lk',
  whatsappNumber: '94770000000',
  heroBanners: [],
  deliveryCharge: 350,
  freeDeliveryMin: 10000,
  seoTitle: 'Zyro.lk | Live Marketplace Sri Lanka',
  seoDescription: 'Live marketplace products delivered across Sri Lanka.',
  seoKeywords: 'marketplace, Sri Lanka',
  ogImageUrl: 'https://zyro.lk/storefront.jpg',
  facebookUrl: 'https://facebook.com/zyro.lk',
};

const product: Product = {
  id: 'live-product-1',
  name: 'Premium Solar Light',
  description: 'A weather-ready outdoor light available from the live catalogue.',
  price: 8250,
  imageUrl: 'https://zyro.lk/products/solar-light.jpg',
  category: 'home-outdoor',
  rating: 4.7,
  reviewsCount: 18,
  isActive: true,
  sku: 'ZY-SOLAR-1',
  stock: 12,
  specs: {},
};

test('Sprint 77 builds page-aware storefront SEO from existing settings', () => {
  const home = buildStorefrontSeo({ currentPage: 'home', settings, origin: 'https://zyro.lk' });
  assert.equal(home.title, settings.seoTitle);
  assert.equal(home.description, settings.seoDescription);
  assert.equal(home.canonical, 'https://zyro.lk/');
  assert.equal(home.type, 'website');
  assert.equal(home.robots, 'index, follow');
  assert.equal(home.structuredData['@type'], 'OnlineStore');
  assert.deepEqual(home.structuredData.sameAs, ['https://facebook.com/zyro.lk']);

  const products = buildStorefrontSeo({ currentPage: 'products', settings, origin: 'https://zyro.lk' });
  assert.equal(products.title, 'Shop Products | Zyro.lk');
  assert.match(products.description, /Browse live marketplace products/);
});

test('Sprint 77 emits live product structured data without changing the Product contract', () => {
  const result = buildStorefrontSeo({ currentPage: 'products', product, settings, origin: 'https://zyro.lk' });
  const offers = result.structuredData.offers as Record<string, unknown>;
  const rating = result.structuredData.aggregateRating as Record<string, unknown>;

  assert.equal(result.title, 'Premium Solar Light | Zyro.lk');
  assert.equal(result.type, 'product');
  assert.equal(result.image, product.imageUrl);
  assert.equal(result.structuredData['@type'], 'Product');
  assert.equal(result.structuredData.sku, product.sku);
  assert.equal(offers.priceCurrency, 'LKR');
  assert.equal(offers.price, product.price);
  assert.equal(offers.availability, 'https://schema.org/InStock');
  assert.equal(rating.reviewCount, product.reviewsCount);

  const unavailable = buildStorefrontSeo({ currentPage: 'products', product: { ...product, stock: 0 }, settings });
  assert.equal((unavailable.structuredData.offers as Record<string, unknown>).availability, 'https://schema.org/OutOfStock');
});

test('private and missing storefront states receive safe indexing directives', () => {
  assert.equal(buildStorefrontSeo({ currentPage: 'wishlist', settings }).robots, 'noindex, follow');
  assert.equal(buildStorefrontSeo({ currentPage: 'does-not-exist', settings }).robots, 'noindex, follow');
  assert.equal(buildStorefrontSeo({ currentPage: 'admin', settings, isAdminMode: true }).robots, 'noindex, follow');
});

test('dynamic metadata covers title, Open Graph, Twitter Cards, canonical URL, and JSON-LD', () => {
  assert.match(app, /<StorefrontSeo[\s\S]*currentPage=\{currentPage\}[\s\S]*product=\{liveSelectedProduct\}/);
  assert.match(seoComponent, /document\.title = seo\.title/);
  assert.match(seoComponent, /'og:title'/);
  assert.match(seoComponent, /'og:description'/);
  assert.match(seoComponent, /'twitter:card'/);
  assert.match(seoComponent, /'twitter:image'/);
  assert.match(seoComponent, /link\[rel="canonical"\]/);
  assert.match(seoComponent, /application\/ld\+json/);
  assert.match(seoComponent, /JSON\.stringify\(seo\.structuredData\)/);
  assert.match(html, /<meta name="twitter:card"/);
  assert.match(html, /rel="preconnect" href="https:\/\/firestore\.googleapis\.com"/);
  assert.match(manifest, /Zyro\.lk Sri Lankan Marketplace/);
});

test('storefront feature boundaries and chunk groups improve initial bundle organization', () => {
  assert.match(app, /const ContactPage = lazy\(\(\) => import\('\.\/components\/ContactPage'\)\)/);
  assert.match(app, /const ProductDetailModal = lazy\(\(\) => import\('\.\/components\/ProductDetailModal'\)\)/);
  assert.doesNotMatch(app, /import ContactPage from/);
  assert.doesNotMatch(app, /import ProductDetailModal from/);
  assert.match(app, /<Suspense fallback=\{<OverlayLoadingFallback label="Loading product details" \/>\}>/);
  assert.match(viteConfig, /id\.includes\('lucide-react'\)[\s\S]*return 'icons'/);
  assert.ok(viteConfig.indexOf("id.includes('lucide-react')") < viteConfig.indexOf("id.includes('react')"));
});

test('storefront imagery has explicit lazy, priority, decoding, and sizing behavior', () => {
  assert.match(productCard, /loading="lazy"[\s\S]*fetchPriority="low"[\s\S]*decoding="async"/);
  assert.match(hero, /loading=\{currentSlide === 0 \? 'eager' : 'lazy'\}/);
  assert.match(hero, /fetchPriority=\{currentSlide === 0 \? 'high' : 'low'\}/);
  assert.match(homepage, /loading="lazy" fetchPriority="low" decoding="async" width="160" height="160"/);
  assert.match(relatedProducts, /loading="lazy" fetchPriority="low" decoding="async" width="600" height="600"/);
  assert.match(footer, /loading="lazy"[\s\S]*fetchPriority="low"[\s\S]*width="220"[\s\S]*height="64"/);
});

test('keyboard navigation, focus management, and accessible loading states are present', () => {
  assert.match(app, /href="#storefront-content" className="zy-skip-link"/);
  assert.match(app, /id="storefront-content"[\s\S]*tabIndex=\{-1\}[\s\S]*aria-busy=\{loading\}/);
  assert.match(app, /requestAnimationFrame\(\(\) => storefrontContentRef\.current\?\.focus\(\{ preventScroll: true \}\)\)/);
  assert.match(app, /role="status" aria-live="polite" aria-label="Loading products"/);
  assert.match(app, /role="status" aria-live="polite" aria-label=\{label\}/);
  assert.match(styles, /\.zy-skip-link:focus-visible[\s\S]*outline: 3px solid #fbbf24/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.zy-storefront-overlay-loading::before/);
});

test('loading, empty, and 404 states remain distinct and actionable', () => {
  const loadingPosition = app.indexOf('{loading ? (');
  const emptyPosition = app.indexOf(': filteredProducts.length === 0 ? (');
  assert.ok(loadingPosition >= 0 && loadingPosition < emptyPosition);
  assert.match(app, /!isKnownStorefrontPage && \(/);
  assert.match(app, /<StorefrontNotFound[\s\S]*onGoHome[\s\S]*onBrowseProducts/);
  assert.match(notFound, /aria-labelledby="storefront-not-found-title"/);
  assert.match(notFound, />404</);
  assert.match(notFound, /Back to homepage/);
  assert.match(notFound, /Browse products/);
  assert.match(styles, /\.zy-storefront-not-found__actions button:focus-visible/);
});

test('Sprint 77 leaves protected commerce and data contracts connected', () => {
  assert.match(app, /product=\{liveSelectedProduct\}/);
  assert.match(app, /onAddToCart=\{handleAddToCart\}/);
  assert.match(app, /onBuyNow=\{handleBuyNow\}/);
  assert.match(app, /onToggleWishlist=\{handleToggleWishlist\}/);
  assert.match(app, /<MarketplaceHomePhase1[\s\S]*settings=\{settings\}/);
  assert.match(homepage, /<HeroBanner[\s\S]*settings=\{settings\}/);
  assert.doesNotMatch(seoComponent, /firebase|firestore|collection\(|onSnapshot\(|updateDoc\(|setDoc\(/iu);
  assert.doesNotMatch(notFound, /firebase|firestore|collection\(|onSnapshot\(|updateDoc\(|setDoc\(/iu);
});
