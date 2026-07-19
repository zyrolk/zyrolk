import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  auditCatalogFoundationState,
  buildConfiguredCatalogState,
  CATALOG_FOUNDATION_BRANDS,
  CATALOG_FOUNDATION_CATEGORIES,
  CATALOG_FOUNDATION_PRODUCTS,
} from '../scripts/catalogFoundationConfig';
import { validateProductForSave } from '../src/services/products/productValidation';
import { projectCustomerProducts } from '../src/services/product-search/customerProjection';
import { searchCustomerProducts } from '../src/services/product-search/customerProductSearch';
import type { Category, Product } from '../src/types';

const categories: Category[] = Object.keys(CATALOG_FOUNDATION_CATEGORIES).map((id) => ({
  id,
  name: id,
  icon: 'Layers',
  isActive: true,
}));

const productCategories: Readonly<Record<string, string>> = {
  '10-pcs-makeup-brush-with-pouch': 'home-kitchen',
  '2-pcs-knee-brace-protector': 'electronics',
  'a9-mini-wireless-camera': 'electronics',
  'califonia-body-shaper': 'electronics',
  'detox-foot-pad-10-pads': 'electronics',
};

const products: Product[] = Object.entries(productCategories).map(([id, category], index) => ({
  id,
  name: id,
  description: 'Existing production description',
  price: 1000 + index,
  originalPrice: 1200 + index,
  imageUrl: `https://example.com/${id}.jpg`,
  imageUrls: [],
  category,
  rating: 0,
  reviewsCount: 0,
  isActive: true,
  sku: `ZY-${index + 1}`,
  stock: index + 1,
  specs: {},
}));

test('every production category has subcategories and a required specification template', () => {
  for (const [categoryId, configuration] of Object.entries(CATALOG_FOUNDATION_CATEGORIES)) {
    assert.ok(configuration.subcategories.length > 0, `${categoryId} requires subcategories`);
    assert.ok(configuration.specificationTemplate.length > 0, `${categoryId} requires a template`);
    assert.ok(configuration.specificationTemplate.some((field) => field.required), `${categoryId} requires a required field`);
  }
});

test('subcategory IDs belong to exactly one configured parent category', () => {
  const parents = new Map<string, string>();
  for (const [categoryId, configuration] of Object.entries(CATALOG_FOUNDATION_CATEGORIES)) {
    for (const subcategory of configuration.subcategories) {
      assert.equal(parents.has(subcategory.id), false, `${subcategory.id} is duplicated across categories`);
      parents.set(subcategory.id, categoryId);
    }
  }
  assert.equal(parents.size, 12);
});

test('production brand registry is controlled, active and free of generated product names', () => {
  assert.deepEqual(CATALOG_FOUNDATION_BRANDS.map((brand) => brand.id), ['generic', 'california-beauty', 'kinoki']);
  assert.equal(CATALOG_FOUNDATION_BRANDS.every((brand) => brand.isActive === true), true);
  assert.equal(new Set(CATALOG_FOUNDATION_BRANDS.map((brand) => brand.id)).size, CATALOG_FOUNDATION_BRANDS.length);
});

test('every current production product has an approved brand and subcategory mapping', () => {
  assert.deepEqual(Object.keys(CATALOG_FOUNDATION_PRODUCTS).sort(), Object.keys(productCategories).sort());
  const brandIds = new Set(CATALOG_FOUNDATION_BRANDS.map((brand) => brand.id));
  for (const [productId, configuration] of Object.entries(CATALOG_FOUNDATION_PRODUCTS)) {
    assert.equal(brandIds.has(configuration.brand), true, `${productId} references an unknown brand`);
    const category = productCategories[productId];
    assert.equal(CATALOG_FOUNDATION_CATEGORIES[category].subcategories.some((item) => item.id === configuration.subcategory), true);
    assert.equal(configuration.specs['Product Type'], configuration.productType);
  }
});

test('configured state passes catalog and Product Editor publication validation', () => {
  const configured = buildConfiguredCatalogState(categories, products);
  assert.deepEqual(auditCatalogFoundationState(configured), []);
  for (const product of configured.products) {
    assert.deepEqual(validateProductForSave({
      product,
      products: configured.products,
      categories: configured.categories,
      brands: configured.brands,
      editingProductId: product.id,
    }), []);
  }
});

test('catalog configuration preserves checkout values and legacy storefront product fields', () => {
  const configured = buildConfiguredCatalogState(categories, products);
  for (const original of products) {
    const updated = configured.products.find((product) => product.id === original.id);
    assert.ok(updated);
    assert.equal(updated.price, original.price);
    assert.equal(updated.originalPrice, original.originalPrice);
    assert.equal(updated.stock, original.stock);
    assert.equal(updated.imageUrl, original.imageUrl);
    assert.equal(updated.category, original.category);
    assert.equal(updated.sku, original.sku);
    assert.equal(updated.rating, original.rating);
    assert.equal(updated.reviewsCount, original.reviewsCount);
  }
});

test('customer search remains compatible with configured brands and the A9 model', () => {
  const configured = buildConfiguredCatalogState(categories, products);
  const projected = projectCustomerProducts(configured.products);
  assert.deepEqual(searchCustomerProducts(projected, 'California Beauty').map((product) => product.id), ['califonia-body-shaper']);
  assert.deepEqual(searchCustomerProducts(projected, 'Kinoki').map((product) => product.id), ['detox-foot-pad-10-pads']);
  assert.deepEqual(searchCustomerProducts(projected, 'A9').map((product) => product.id), ['a9-mini-wireless-camera']);
});

test('production runner is explicit, merge-only, atomic and credential-gated', () => {
  const runner = readFileSync('scripts/catalogFoundation.ts', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.match(runner, /CATALOG_FOUNDATION_CONFIRM/);
  assert.match(runner, /applicationDefault\(\)/);
  assert.match(runner, /const batch = db\.batch\(\)/);
  assert.match(runner, /await batch\.commit\(\)/);
  assert.match(runner, /\{ merge: true \}/);
  assert.doesNotMatch(runner, /\.delete\(/);
  assert.equal(packageJson.scripts['catalog:foundation:dry-run'], 'tsx scripts/catalogFoundation.ts');
  assert.equal(packageJson.scripts['catalog:foundation:apply'], 'tsx scripts/catalogFoundation.ts --apply');
});
