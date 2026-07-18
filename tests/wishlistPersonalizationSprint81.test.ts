import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildComparisonRows,
  buildPersonalizedRecommendations,
  cleanRecentlyViewedIds,
  mergeRecentlyViewedIds,
  reconcileWishlistProducts,
  resolveComparedProducts,
  toggleCompareProduct,
} from '../src/features/personalization/personalization';
import { Product } from '../src/types';

const app = readFileSync('src/App.tsx', 'utf8');
const wishlistView = readFileSync('src/features/personalization/WishlistExperience.tsx', 'utf8');
const compareView = readFileSync('src/features/personalization/CompareProducts.tsx', 'utf8');
const recommendations = readFileSync('src/features/personalization/PersonalizedRecommendations.tsx', 'utf8');
const styles = readFileSync('src/features/personalization/personalization.css', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNav = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const rules = readFileSync('firestore.rules', 'utf8');

const product = (id: string, overrides: Partial<Product> = {}): Product => ({
  id,
  name: `Product ${id}`,
  description: '',
  price: 1000,
  imageUrl: '',
  category: 'electronics',
  rating: 4,
  reviewsCount: 2,
  stock: 5,
  specs: { Brand: 'Zyro', Color: 'Black' },
  isActive: true,
  ...overrides,
});

test('wishlist reconciliation preserves saved snapshots for honest live price-change badges', () => {
  const saved = [product('one', { price: 1500 }), product('two', { price: 1000 }), product('missing', { price: 900 })];
  const live = [product('one', { price: 1200 }), product('two', { price: 1250 })];
  const result = reconcileWishlistProducts(saved, live);
  assert.equal(result[0].priceChange, 'decreased');
  assert.equal(result[0].priceDifference, 300);
  assert.equal(result[0].priceChangePercent, 20);
  assert.equal(result[1].priceChange, 'increased');
  assert.equal(result[2].isAvailable, false);
  assert.equal(result[2].product.price, 900);
});

test('wishlist reconciliation deduplicates saved IDs while retaining source ordering', () => {
  const saved = [product('one'), product('one', { price: 800 }), product('two')];
  assert.deepEqual(reconcileWishlistProducts(saved, saved).map(item => item.id), ['one', 'two']);
});

test('recently viewed merge keeps local recency, deduplicates cloud history, and stays bounded', () => {
  assert.deepEqual(mergeRecentlyViewedIds(['local-new', 'shared'], ['shared', 'cloud-old'], 3), ['local-new', 'shared', 'cloud-old']);
  assert.deepEqual(mergeRecentlyViewedIds(['a', 'b', 'c'], ['d'], 2), ['a', 'b']);
});

test('recently viewed cleanup removes missing, inactive, duplicated, and invalid product IDs', () => {
  const products = [product('active'), product('inactive', { isActive: false }), product('other')];
  assert.deepEqual(cleanRecentlyViewedIds(['active', 'missing', 'inactive', 'active', '', 'other'], products), ['active', 'other']);
});

test('compare selection toggles deterministically and enforces the four-product maximum', () => {
  assert.deepEqual(toggleCompareProduct([], 'one'), { ids: ['one'], outcome: 'added' });
  assert.deepEqual(toggleCompareProduct(['one'], 'one'), { ids: [], outcome: 'removed' });
  assert.deepEqual(toggleCompareProduct(['one', 'two', 'three', 'four'], 'five'), {
    ids: ['one', 'two', 'three', 'four'], outcome: 'limit-reached',
  });
  assert.deepEqual(toggleCompareProduct(['one'], '  '), { ids: ['one'], outcome: 'invalid' });
});

test('compared products resolve only current active catalogue products in selected order', () => {
  const products = [product('two'), product('one'), product('inactive', { isActive: false })];
  assert.deepEqual(resolveComparedProducts(['one', 'inactive', 'two', 'missing'], products).map(item => item.id), ['one', 'two']);
});

test('comparison rows include price, availability, category, brand, and the union of specifications', () => {
  const rows = buildComparisonRows([
    product('one', { price: 1000, stock: 5, specs: { Brand: 'Zyro', Color: 'Black', RAM: '8 GB' } }),
    product('two', { price: 1200, stock: 0, specs: { Brand: 'Zyro', Color: 'Blue', Storage: '128 GB' } }),
  ]);
  assert.deepEqual(rows.slice(0, 4).map(row => row.key), ['price', 'availability', 'category', 'brand']);
  assert.equal(rows.find(row => row.key === 'price')?.different, true);
  assert.equal(rows.find(row => row.key === 'brand')?.different, false);
  assert.ok(rows.some(row => row.key === 'ram'));
  assert.ok(rows.some(row => row.key === 'storage'));
});

test('rule-based recommendations expose every required shelf using live explicit signals', () => {
  const focus = product('focus', { category: 'phones', specs: { Brand: 'Acme' } });
  const sections = buildPersonalizedRecommendations({
    products: [
      focus,
      product('brand', { category: 'audio', specs: { Brand: 'Acme' } }),
      product('category', { category: 'phones', specs: { Brand: 'Other' } }),
      product('best', { isBestSeller: true }),
      product('trend', { isFeatured: true, reviewsCount: 20 }),
      product('new', { isNew: true, createdAt: '2026-07-18T00:00:00.000Z' }),
      product('inactive', { isActive: false, isBestSeller: true }),
    ],
    wishlist: [],
    recentlyViewed: [focus],
  });
  assert.deepEqual(sections.map(section => section.id), [
    'related', 'brand', 'category', 'best-sellers', 'trending', 'new-arrivals', 'frequently-bought-together',
  ]);
  assert.deepEqual(sections.find(section => section.id === 'brand')?.products.map(item => item.id), ['brand']);
  assert.deepEqual(sections.find(section => section.id === 'category')?.products.map(item => item.id), ['category']);
  assert.ok(sections.find(section => section.id === 'best-sellers')?.products.some(item => item.id === 'best'));
  assert.equal(sections.find(section => section.id === 'frequently-bought-together')?.foundation, true);
  assert.deepEqual(sections.find(section => section.id === 'frequently-bought-together')?.products, []);
});

test('recommendations never fabricate best-seller or co-purchase results', () => {
  const sections = buildPersonalizedRecommendations({ products: [product('ordinary', { isBestSeller: false })], wishlist: [], recentlyViewed: [] });
  assert.deepEqual(sections.find(section => section.id === 'best-sellers')?.products, []);
  assert.deepEqual(sections.find(section => section.id === 'frequently-bought-together')?.products, []);
});

test('App preserves the existing wishlist document contract and adds bounded recent-ID account sync', () => {
  assert.match(app, /updateDoc\(userRef, \{ wishlist \}\)/);
  assert.match(app, /userData\.wishlist/);
  assert.match(app, /userData\.recentlyViewedProductIds/);
  assert.match(app, /updateDoc\(userRef, \{ recentlyViewedProductIds \}\)/);
  assert.match(app, /mergeRecentlyViewedIds/);
  assert.match(app, /cleanRecentlyViewedIds/);
  assert.match(app, /'zyro_recently_viewed'/);
  assert.match(app, /'zyro_compare_products'/);
});

test('Wishlist 2.0 includes account sync, bulk selection, move-to-cart, stock, price, and unavailable states', () => {
  assert.match(wishlistView, /Account sync active/);
  assert.match(wishlistView, /Select all/);
  assert.match(wishlistView, /Move to cart/);
  assert.match(wishlistView, /onRemoveWishlistItems/);
  assert.match(wishlistView, /Price dropped/);
  assert.match(wishlistView, /Price increased/);
  assert.match(wishlistView, /Only \$\{item\.product\.stock\} left/);
  assert.match(wishlistView, /no longer active in the live catalogue/);
  assert.match(wishlistView, /<ProductCard/);
});

test('recently viewed history supports clear confirmation, inactive cleanup messaging, and account synchronization', () => {
  assert.match(wishlistView, /Recently Viewed/);
  assert.match(wishlistView, /Confirm clear history/);
  assert.match(wishlistView, /onClearHistory\(\)/);
  assert.match(wishlistView, /Inactive products are removed automatically/);
  assert.match(wishlistView, /Signed-in history synchronizes across devices/);
});

test('compare experience supports search, four slots, highlighted differences, commerce, and removal', () => {
  assert.match(compareView, /Compare up to four live products/);
  assert.match(compareView, /Search name, category, or brand/);
  assert.match(compareView, /4 - comparedProducts\.length/);
  assert.match(compareView, /row\.different \? 'is-different'/);
  assert.match(compareView, /Remove \$\{product\.name\} from comparison/);
  assert.match(compareView, /Add to cart/);
  assert.match(compareView, /onToggleWishlist/);
  assert.match(compareView, /tabIndex=\{0\}/);
});

test('personalized UI renders live ProductCard commerce actions and an honest FBT foundation', () => {
  assert.match(recommendations, /<ProductCard/);
  assert.match(recommendations, /Rule-based discovery/);
  assert.match(recommendations, /Foundation ready — no aggregate purchase signal yet/);
  assert.match(recommendations, /onToggleCompare/);
  assert.doesNotMatch(recommendations, /Math\.random|mock|fake/iu);
});

test('personalized pages are connected through existing state navigation on desktop and mobile', () => {
  assert.match(app, /'wishlist', 'recently-viewed', 'compare'/);
  assert.match(app, /<WishlistExperience/);
  assert.match(app, /<CompareProducts/);
  assert.match(navbar, /label: 'Recently Viewed'[\s\S]*navigateToPage\('recently-viewed'\)/);
  assert.match(navbar, /label: 'Compare Products'[\s\S]*navigateToPage\('compare'\)/);
  assert.match(mobileNav, /handleTabClick\('recently-viewed'\)/);
  assert.match(mobileNav, /handleTabClick\('compare'\)/);
});

test('Firestore security remains owner-scoped without adding public personalization collections', () => {
  assert.match(rules, /match \/users\/\{userId\}[\s\S]*allow read: if isOwner\(userId\) \|\| isAdmin\(\)/);
  assert.match(rules, /isOwner\(userId\)[\s\S]*request\.resource\.data\.role == resource\.data\.role/);
  assert.doesNotMatch(rules, /match \/wishlist|match \/recentlyViewed|match \/comparisons/);
});

test('premium personalization styling covers responsive rails, skeletons, focus, motion, and forced colors', () => {
  assert.match(styles, /\.zy-personalization-skeleton/);
  assert.match(styles, /\.zy-personalized-product-rail[\s\S]*scroll-snap-type/);
  assert.match(styles, /\.zy-compare-table-wrap[\s\S]*overflow: auto/);
  assert.match(styles, /\.zy-compare-table tr\.is-different/);
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /@media \(forced-colors: active\)/);
});

test('Sprint 81 stays out of protected admin, supplier, checkout, and AI implementations', () => {
  const changedFeatureSources = `${wishlistView}\n${compareView}\n${recommendations}`;
  assert.doesNotMatch(changedFeatureSources, /AdminDashboard|SupplierHub|AIManager|\/api\/checkout|supplier_/);
});
