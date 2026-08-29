import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildStorefrontUrl, parseStorefrontRoute } from '../src/services/navigation/storefrontRoutes';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import { Category, Product, WebsiteSettings } from '../src/types';

const source = (path: string): string => readFileSync(path, 'utf8');

const settings: WebsiteSettings = {
  storeName: 'Zyro.lk',
  whatsappNumber: '94770000000',
  heroBanners: [],
  deliveryCharge: 350,
  freeDeliveryMin: 10000,
  ogImageUrl: 'https://zyro.lk/social.jpg',
};

const category: Category = { id: 'mobile-phones', name: 'Mobile Phones', icon: 'smartphone', isActive: true };
const product: Product = {
  id: 'phone/launch 1',
  name: 'Launch Phone',
  description: 'A real live product with current pricing and availability.',
  price: 125000,
  imageUrl: 'https://zyro.lk/media/launch-phone.webp',
  category: category.id,
  rating: 0,
  reviewsCount: 0,
  stock: 3,
  specs: {},
  isActive: true,
};

test('durable storefront routes round-trip public pages, products, categories, and search', () => {
  assert.deepEqual(parseStorefrontRoute('/', ''), { page: 'home' });
  assert.deepEqual(parseStorefrontRoute('/account/orders', ''), { page: 'account-orders' });
  assert.deepEqual(parseStorefrontRoute('/products/phone%2Flaunch%201', ''), { page: 'products', productId: product.id });
  assert.deepEqual(parseStorefrontRoute('/categories/mobile-phones/', ''), { page: 'products', categoryId: category.id });
  assert.deepEqual(parseStorefrontRoute('/search', '?q=launch%20phone'), { page: 'products', searchQuery: 'launch phone' });
  assert.deepEqual(parseStorefrontRoute('/', '?product=legacy-product'), { page: 'products', productId: 'legacy-product' });
  assert.equal(buildStorefrontUrl({ page: 'products', productId: product.id }), '/products/phone%2Flaunch%201');
  assert.equal(buildStorefrontUrl({ page: 'products', categoryId: category.id }), '/categories/mobile-phones');
  assert.equal(buildStorefrontUrl({ page: 'products', searchQuery: 'launch phone' }), '/search?q=launch%20phone');
});

test('SEO uses durable canonicals and appropriate product and category structured data', () => {
  const productSeo = buildStorefrontSeo({ currentPage: 'products', product, settings });
  assert.equal(productSeo.canonical, 'https://zyro.lk/products/phone%2Flaunch%201');
  assert.equal(productSeo.type, 'product');
  assert.equal(productSeo.robots, 'index, follow');
  const productGraph = productSeo.structuredData['@graph'] as Array<Record<string, unknown>>;
  assert.ok(productGraph.some((item) => item['@type'] === 'Product'));
  assert.ok(productGraph.some((item) => item['@type'] === 'BreadcrumbList'));

  const categorySeo = buildStorefrontSeo({ currentPage: 'products', category, requestedCategoryId: category.id, settings });
  assert.equal(categorySeo.canonical, 'https://zyro.lk/categories/mobile-phones');
  assert.match(categorySeo.title, /Mobile Phones Products/);
  assert.equal(categorySeo.structuredData['@type'], 'CollectionPage');
  const categoryGraph = categorySeo.structuredData['@graph'] as Array<Record<string, unknown>>;
  assert.ok(categoryGraph.some((item) => item['@type'] === 'CollectionPage'));
  assert.ok(categoryGraph.some((item) => item['@type'] === 'BreadcrumbList'));
});

test('private, search, invalid product, and invalid category URLs remain non-indexable', () => {
  assert.equal(buildStorefrontSeo({ currentPage: 'products', searchQuery: 'phone', settings }).robots, 'noindex, follow');
  assert.equal(buildStorefrontSeo({ currentPage: 'products', requestedProductId: 'missing', settings }).robots, 'noindex, follow');
  assert.equal(buildStorefrontSeo({ currentPage: 'products', requestedCategoryId: 'missing', settings }).robots, 'noindex, follow');
  assert.equal(buildStorefrontSeo({ currentPage: 'account-orders', settings }).canonical, 'https://zyro.lk/account/orders');
});

test('App restores browser history, deep links directly, and preserves legacy product links', () => {
  const app = source('src/App.tsx');
  assert.match(app, /parseStorefrontRoute\(window\.location\.pathname, window\.location\.search\)/);
  assert.match(app, /window\.addEventListener\('popstate', applyLocation\)/);
  assert.match(app, /window\.history\.pushState\(state, '', nextUrl\)/);
  assert.match(app, /loadStorefrontProductsByIds\(db, \[routedProductId\]\)/);
  assert.match(app, /setRoutedProductId\(product\.id\)/);
  assert.match(app, /zyroProductOverlay/);
});

test('launch search presentation does not expose blocked voice controls or unimplemented AI claims', () => {
  const hero = source('src/components/HeroBanner.tsx');
  const navbar = source('src/components/Navbar.tsx');
  for (const presentation of [hero, navbar]) {
    assert.doesNotMatch(presentation, /SpeechRecognition|webkitSpeechRecognition/);
    assert.doesNotMatch(presentation, /Voice search is unavailable in this launch version/);
    assert.doesNotMatch(presentation, /Image search is coming soon/);
  }
  assert.doesNotMatch(hero, /AI-Powered Marketplace|AI-assisted search|AI Shopping Assistant/);
  assert.doesNotMatch(navbar, /Ask Zyro AI|AI Shopping Assistant|AI-assisted product discovery/);
});

test('sitemap and robots expose durable public URLs while excluding private customer routes', () => {
  const functions = source('functions/src/api/app.ts');
  const preview = source('server.ts');
  const robots = source('public/robots.txt');
  for (const sitemap of [functions, preview]) {
    assert.match(sitemap, /zyro\.lk\/products\/\$\{encodeURIComponent\(product\.id\)\}/);
    assert.match(sitemap, /zyro\.lk\/categories\/\$\{encodeURIComponent\(category\.id\)\}/);
    assert.doesNotMatch(sitemap, /zyro\.lk\/\?product=/);
  }
  for (const route of ['/admin', '/api/', '/account', '/wishlist', '/recently-viewed', '/compare', '/search']) {
    assert.match(robots, new RegExp(`Disallow: ${route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  }
  assert.match(robots, /Sitemap: https:\/\/zyro\.lk\/sitemap\.xml/);
});
