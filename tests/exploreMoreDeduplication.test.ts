import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectExploreMoreProducts } from '../src/services/storefront/launchMerchandising';

const source = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
const app = source('src/App.tsx');
const homepage = source('src/components/MarketplaceHomePhase1.tsx');

const catalog = Array.from({ length: 20 }, (_, index) => ({ id: `p${String(index + 1).padStart(2, '0')}` }));
const ids = (products: readonly { id: string }[]): string[] => products.map((product) => product.id);
const pick = (...productIds: string[]) => catalog.filter((product) => productIds.includes(product.id));

test('Explore More excludes New Arrivals, Featured, Best Sellers and Flash Deals', () => {
  const newArrivals = catalog.slice(0, 8);
  const featured = pick('p09', 'p10');
  const bestSellers = pick('p11');
  const deals = pick('p12', 'p13');
  const explore = selectExploreMoreProducts(catalog, [newArrivals, featured, bestSellers, deals]);

  assert.deepEqual(ids(explore), ['p14', 'p15', 'p16', 'p17', 'p18', 'p19', 'p20']);
  for (const shelf of [newArrivals, featured, bestSellers, deals]) {
    assert.equal(explore.filter((product) => ids(shelf).includes(product.id)).length, 0);
  }
});

test('each excluded shelf is removed on its own', () => {
  assert.deepEqual(ids(selectExploreMoreProducts(catalog, [catalog.slice(0, 8)])), ids(catalog.slice(8, 16)));
  assert.ok(!ids(selectExploreMoreProducts(catalog, [pick('p01')])).includes('p01'));
  assert.ok(!ids(selectExploreMoreProducts(catalog, [[], pick('p02')])).includes('p02'));
  assert.ok(!ids(selectExploreMoreProducts(catalog, [[], [], [], pick('p03')])).includes('p03'));
});

test('Explore More is deterministic, keeps stable order and never refills with duplicates', () => {
  const shelves = [catalog.slice(0, 8), [], [], []];
  const first = selectExploreMoreProducts(catalog, shelves);
  const second = selectExploreMoreProducts([...catalog], shelves.map((shelf) => [...shelf]));
  assert.deepEqual(ids(first), ids(second));
  assert.deepEqual(ids(first), ['p09', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16']);

  const short = selectExploreMoreProducts(catalog.slice(0, 10), [catalog.slice(0, 8)]);
  assert.deepEqual(ids(short), ['p09', 'p10']);
  assert.deepEqual(selectExploreMoreProducts(catalog.slice(0, 8), [catalog.slice(0, 8)]), []);
  assert.doesNotMatch(source('src/services/storefront/launchMerchandising.ts'), /Math\.random|shuffle/u);
});

test('App feeds Explore More every other shelf and leaves New Arrivals unchanged', () => {
  assert.match(app, /const newArrivalProducts = useMemo\(\n\s+\(\) => activeProducts\.filter\(product => product\.isNew\)\.slice\(0, 8\),\n\s+\[activeProducts\]\n\s+\);/u);
  assert.match(app, /selectExploreMoreProducts\(activeProducts, \[newArrivalProducts, trendingProducts, bestSellerProducts, discountedProducts\]\)/u);
  assert.match(app, /recommendedProducts=\{recommendedProducts\}/u);
});

test('empty Featured, Best Sellers and Flash Deals shelves stay hidden', () => {
  assert.match(homepage, /const shouldShowPreviewShelf = Boolean\(previewPresentation\) && shelf\.tone === 'recommended' && !hasLiveProducts;/u);
  assert.match(homepage, /if \(loading \|\| hasLiveProducts\) \{/u);
  assert.match(homepage, /if \(!shouldShowPreviewShelf \|\| !previewPresentation\) return null;/u);
  for (const shelf of ['flashDeals', 'featured', 'bestSellers']) {
    assert.match(homepage, new RegExp(`homepageSections\\.${shelf}\\.enabled && renderShelf\\(`, 'u'));
  }
});
