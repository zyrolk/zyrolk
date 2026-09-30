import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildStorefrontUrl, parseStorefrontRoute } from '../src/services/navigation/storefrontRoutes';

const read = (path: string): string => readFileSync(path, 'utf8');

test('New Arrivals and Best Sellers use explicit listing URLs instead of generic products', () => {
  assert.deepEqual(parseStorefrontRoute('/products', '?view=new-arrivals'), {
    page: 'products',
    listingMode: 'new-arrivals',
  });
  assert.deepEqual(parseStorefrontRoute('/products', '?view=best-sellers'), {
    page: 'products',
    listingMode: 'best-sellers',
  });
  assert.equal(buildStorefrontUrl({ page: 'products', listingMode: 'new-arrivals' }), '/products?view=new-arrivals');
  assert.equal(buildStorefrontUrl({ page: 'products', listingMode: 'best-sellers' }), '/products?view=best-sellers');
});

test('generic Products and unrelated URL state remain unchanged', () => {
  assert.deepEqual(parseStorefrontRoute('/products', ''), { page: 'products', listingMode: undefined });
  assert.equal(buildStorefrontUrl({ page: 'products' }), '/products');
  assert.equal(buildStorefrontUrl({ page: 'products', searchQuery: 'phone', listingMode: 'new-arrivals' }), '/search?q=phone');
  assert.deepEqual(parseStorefrontRoute('/products', '?view=unknown'), { page: 'products', listingMode: undefined });
});

test('desktop and mobile navigation share the same listing-mode actions and App applies shelf predicates', () => {
  const navbar = read('src/components/Navbar.tsx');
  const app = read('src/App.tsx');
  assert.match(navbar, /new-arrivals[^\n]+navigateToListingMode\('new-arrivals'\)/);
  assert.match(navbar, /best-sellers[^\n]+navigateToListingMode\('best-sellers'\)/);
  assert.match(navbar, /const mobileBrowseLinks = \['new-arrivals', 'deals'\]/);
  assert.match(app, /listingMode === 'new-arrivals' \? product\.isNew : product\.isBestSeller/);
  assert.match(app, /onSelectListingMode=\{handleSelectListingMode\}/);
  assert.match(app, /const navigateToPage = useCallback\(\(page: string\) => \{\s*setListingMode\(undefined\);\s*setCurrentPage\(page\);/);
  assert.match(app, /const handleSelectListingMode = useCallback\(\(mode: StorefrontListingMode\) => \{\s*setListingMode\(mode\);\s*setCurrentPage\('products'\);/);
});
