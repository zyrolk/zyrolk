import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import { Product, WebsiteSettings } from '../src/types';

const app = readFileSync('src/App.tsx', 'utf8');
const html = readFileSync('index.html', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');
const manifest = readFileSync('public/manifest.json', 'utf8');
const robots = readFileSync('public/robots.txt', 'utf8');
const seoComponent = readFileSync('src/components/StorefrontSeo.tsx', 'utf8');

const settings: WebsiteSettings = {
  storeName: 'Zyro.lk',
  whatsappNumber: '94770000000',
  heroBanners: [],
  deliveryCharge: 350,
  freeDeliveryMin: 10000,
  seoTitle: 'Zyro.lk | Marketplace Sri Lanka',
  seoDescription: 'Shop current marketplace products delivered across Sri Lanka.',
  seoKeywords: 'marketplace, Sri Lanka',
  ogImageUrl: 'https://zyro.lk/storefront.jpg',
};

const product: Product = {
  id: 'l8-product',
  name: 'Launch-ready product',
  description: 'A genuine product description for structured product metadata.',
  price: 6500,
  imageUrl: 'https://zyro.lk/products/launch-ready.jpg',
  category: 'home',
  rating: 4.5,
  reviewsCount: 8,
  isActive: true,
  sku: 'L8-READY',
  stock: 4,
  specs: {},
};

test('Sprint L8 retains a production canonical URL and complete social metadata', () => {
  assert.match(seoComponent, /origin: 'https:\/\/zyro\.lk'/);
  assert.match(seoComponent, /'og:site_name'/);
  assert.match(seoComponent, /'og:locale'/);
  assert.match(seoComponent, /'og:image:alt'/);
  assert.match(seoComponent, /'twitter:domain'/);
  assert.match(seoComponent, /'twitter:image:alt'/);
  assert.match(html, /<link rel="canonical" href="https:\/\/zyro\.lk\/" \/>/);
  assert.match(html, /<meta property="og:site_name" content="Zyro\.lk" \/>/);
  assert.match(html, /<meta name="twitter:image:alt"/);
});

test('Sprint L8 emits organization, website, product, offer, and product-only breadcrumb data', () => {
  const home = buildStorefrontSeo({ currentPage: 'home', settings });
  const homeGraph = home.structuredData['@graph'] as Array<Record<string, unknown>>;
  assert.ok(homeGraph.some(item => item['@type'] === 'Organization'));
  assert.ok(homeGraph.some(item => item['@type'] === 'WebSite'));
  assert.ok(homeGraph.some(item => item['@type'] === 'OnlineStore'));
  assert.equal(homeGraph.some(item => item['@type'] === 'BreadcrumbList'), false);

  const detail = buildStorefrontSeo({ currentPage: 'products', product, settings });
  const graph = detail.structuredData['@graph'] as Array<Record<string, unknown>>;
  const productData = graph.find(item => item['@type'] === 'Product') as Record<string, unknown>;
  const offer = productData.offers as Record<string, unknown>;
  assert.equal(productData.mainEntityOfPage, detail.canonical);
  assert.equal(productData['@id'], `${detail.canonical}#product`);
  assert.equal(offer.priceCurrency, 'LKR');
  assert.ok(graph.some(item => item['@type'] === 'BreadcrumbList'));
});

test('static SEO and PWA metadata is launch-ready without inventing routes', () => {
  assert.match(html, /<html lang="en-LK">/);
  assert.match(html, /zyro-static-structured-data/);
  assert.match(html, /@type\\?":"Organization/);
  assert.match(html, /@type\\?":"WebSite/);
  assert.match(html, /rel="manifest" href="\/manifest\.json"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(manifest, /"description"/);
  assert.match(manifest, /"lang": "en-LK"/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: https:\/\/zyro\.lk\/sitemap\.xml/);
});

test('font loading is moved out of the stylesheet import chain for a faster render path', () => {
  assert.doesNotMatch(styles, /@import url\('https:\/\/fonts\.googleapis\.com/u);
  assert.match(html, /rel="preconnect" href="https:\/\/fonts\.googleapis\.com"/);
  assert.match(html, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Inter/);
});

test('favicon handling falls back safely and preserves existing storefront state', () => {
  assert.match(app, /let faviconUrl = '\/favicon\.png'/);
  assert.match(app, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
  assert.match(app, /appleTouchIcon\.href = faviconUrl/);
  assert.doesNotMatch(seoComponent, /firebase|firestore|collection\(|onSnapshot\(/iu);
  assert.match(app, /onAddToCart=\{handleAddToCart\}/);
  assert.match(app, /onBuyNow=\{handleBuyNow\}/);
});
