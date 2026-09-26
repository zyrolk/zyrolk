import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatCategoryDisplayName,
  humanizeCategoryId,
  resolveCategoryDisplayName,
} from '../src/services/storefront/launchMerchandising';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import type { Category, Product } from '../src/types';

const source = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const categories: Category[] = [
  { id: 'fashion', name: 'fashion', icon: 'shirt' },
  { id: 'home-garden', name: 'Home & Garden', icon: 'home', subcategories: [{ id: 'garden-tools', name: 'Garden Tools' } as never] },
  { id: 'health-beauty', name: 'Health & Beauty', icon: 'sparkles' },
  { id: 'kids-toys', name: 'Kids & Toys', icon: 'toy' },
  { id: 'solar-lighting', name: 'Solar & Lighting', icon: 'sun' },
];

const product = {
  id: 'p1', name: 'Garden Hose', description: 'Hose', price: 1000, imageUrl: '', category: 'home-garden',
  subcategory: 'garden-tools', rating: 0, reviewsCount: 0, stock: 3, isActive: true,
} as Product;

test('canonical category name wins over the raw product category ID', () => {
  assert.equal(resolveCategoryDisplayName('fashion', categories), 'Fashion');
  assert.equal(resolveCategoryDisplayName('home-garden', categories), 'Home & Garden');
  assert.equal(resolveCategoryDisplayName('health-beauty', categories), 'Health & Beauty');
  assert.equal(resolveCategoryDisplayName('kids-toys', categories), 'Kids & Toys');
  assert.equal(resolveCategoryDisplayName('solar-lighting', categories), 'Solar & Lighting');
  assert.equal(resolveCategoryDisplayName(' SOLAR-LIGHTING ', categories), 'Solar & Lighting');
});

test('unknown or unloaded category IDs fall back to a readable title', () => {
  assert.equal(resolveCategoryDisplayName('home-garden', []), 'Home Garden');
  assert.equal(resolveCategoryDisplayName('outdoor__party--gear', categories), 'Outdoor Party Gear');
  assert.equal(humanizeCategoryId('SOLAR-LIGHTING'), 'Solar Lighting');
  assert.equal(resolveCategoryDisplayName('', categories), '');
  assert.equal(resolveCategoryDisplayName(undefined, categories), '');
  assert.equal(resolveCategoryDisplayName('blank', [{ id: 'blank', name: '  ' }]), 'Blank');
  assert.equal(formatCategoryDisplayName('fashion'), 'Fashion');
});

test('resolving and SEO building never mutate source category or product objects', () => {
  const frozenCategories = deepFreeze(structuredClone(categories));
  const frozenProduct = deepFreeze(structuredClone(product));
  const before = JSON.stringify({ frozenCategories, frozenProduct });
  resolveCategoryDisplayName(frozenProduct.category, frozenCategories);
  buildStorefrontSeo({ currentPage: 'products', product: frozenProduct, categories: frozenCategories, origin: 'https://zyro.lk' });
  buildStorefrontSeo({ currentPage: 'products', category: frozenCategories[0], categories: frozenCategories, requestedCategoryId: 'fashion', origin: 'https://zyro.lk' });
  assert.equal(JSON.stringify({ frozenCategories, frozenProduct }), before);
});

test('SEO uses display names while URLs keep the original category IDs', () => {
  const productSeo = buildStorefrontSeo({ currentPage: 'products', product, categories, origin: 'https://zyro.lk' });
  const graph = productSeo.structuredData['@graph'] as Record<string, unknown>[];
  const productData = graph.find((entry) => entry['@type'] === 'Product');
  const breadcrumb = graph.find((entry) => entry['@type'] === 'BreadcrumbList') as { itemListElement: { name: string; item: string }[] };
  assert.equal(productData?.category, 'Home & Garden');
  assert.equal(breadcrumb.itemListElement[1].name, 'Home & Garden');
  assert.match(breadcrumb.itemListElement[1].item, /home-garden/u);

  const categorySeo = buildStorefrontSeo({ currentPage: 'products', category: categories[0], categories, requestedCategoryId: 'fashion', origin: 'https://zyro.lk' });
  assert.equal(categorySeo.title, 'Fashion Products | Zyro.lk');
  assert.match(categorySeo.canonical, /fashion/u);
  assert.doesNotMatch(categorySeo.canonical, /Fashion/u);
});

test('product-level labels resolve through the shared category display context', () => {
  for (const path of [
    'src/components/ProductCard.tsx',
    'src/components/ProductDetailModal.tsx',
    'src/features/product-experience/RelatedProductsRail.tsx',
    'src/features/personalization/CompareProducts.tsx',
  ]) {
    const file = source(path);
    assert.match(file, /useCategoryDisplayName\(\)/u, path);
    assert.match(file, /categoryDisplayName\(sanitizeStorefrontCategoryId\((product|item)\.category\)\)/u, path);
  }
  for (const path of ['src/components/ProductCard.tsx', 'src/App.tsx']) {
    assert.doesNotMatch(source(path), /\.replace\('-', ' '\)/u, path);
  }
  assert.doesNotMatch(source('src/components/ProductDetailModal.tsx'), /sanitizeStorefrontCategoryId\(product\.category\)\.replace/u);

  const context = source('src/components/CategoryDisplayContext.tsx');
  assert.doesNotMatch(context, /firebase|fetch\(|setDoc|updateDoc|addDoc/u);
  assert.match(context, /createContext<readonly Category\[\]>\(\[\]\)/u);
});

test('App formats loaded category names for presentation and shares them read-only', () => {
  const app = source('src/App.tsx');
  assert.match(app, /\.map\(\(category\) => \(\{ \.\.\.category, name: formatCategoryDisplayName\(category\.name\) \}\)\)/u);
  assert.match(app, /<CategoryDisplayProvider value=\{categories\}>/u);
  assert.match(app, /resolveCategoryDisplayName\(selectedCategory, categories\)/u);
  assert.match(app, /setSelectedCategory\(cat\.id\)/u);
});

test('subcategory labels and Supplier Hub taxonomy mapping are untouched', () => {
  assert.match(source('src/components/MarketplaceMegaMenu.tsx'), /\{subcategory\.name\}/u);
  for (const path of [
    'src/services/supplierCategoryMapping.ts',
    'src/components/SupplierHubFiveStars.tsx',
    'functions/src/scheduled/supplierCategoryMapping.ts',
    'functions/src/api/suppliers/supplierCategoryMappingAdmin.ts',
  ]) {
    assert.doesNotMatch(source(path), /resolveCategoryDisplayName|CategoryDisplayContext|humanizeCategoryId/u, path);
  }
  const formatted = categories.map((category) => ({ ...category, name: formatCategoryDisplayName(category.name) }));
  assert.equal(formatted[1].subcategories, categories[1].subcategories);
  assert.equal(categories[0].name, 'fashion');
});
