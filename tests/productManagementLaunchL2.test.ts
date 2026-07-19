import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  countProductsForBrand,
  isDuplicateBrand,
  normalizeBrandId,
  normalizeBrandName,
  resolveRegisteredBrandId,
  sortBrandsAlphabetically,
} from '../src/services/brands/brandUtils';
import {
  applySpecificationTemplate,
  buildProductSavePayload,
  createProductDraft,
  getActiveSubcategories,
  normalizeCategoryBlueprint,
  normalizeProductForEditor,
  normalizeSpecificationTemplate,
  normalizeSubcategories,
} from '../src/services/products/productBlueprint';
import { validateProductForSave } from '../src/services/products/productValidation';
import type { Brand, Category, Product } from '../src/types';

const brands: Brand[] = [
  { id: 'sony', name: 'Sony', isActive: true },
  { id: 'legacy-brand', name: 'Legacy Brand', isActive: false },
];

const categories: Category[] = [{
  id: 'electronics',
  name: 'Electronics',
  icon: 'Layers',
  isActive: true,
  subcategories: [
    { id: 'phones', name: 'Phones', isActive: true },
    { id: 'retired', name: 'Retired', isActive: false },
  ],
  specificationTemplate: [
    { name: 'Display', required: true },
    { name: 'Battery', required: false },
  ],
}];

const product = (overrides: Partial<Product> = {}): Product => ({
  id: 'phone',
  name: 'Phone',
  description: 'Product description',
  price: 100,
  originalPrice: 120,
  imageUrl: 'https://example.com/phone.jpg',
  imageUrls: [],
  category: 'electronics',
  subcategory: 'phones',
  brand: 'sony',
  rating: 4.5,
  reviewsCount: 9,
  sku: 'ZY-1',
  stock: 2,
  specs: { Display: 'OLED' },
  isActive: true,
  ...overrides,
});

test('brand registry normalization, uniqueness and product references are deterministic', () => {
  assert.equal(normalizeBrandName('  Sony   Electronics  '), 'Sony Electronics');
  assert.equal(normalizeBrandId(' Sony Electronics '), 'sony-electronics');
  assert.equal(isDuplicateBrand(brands, 'SONY', 'Different'), true);
  assert.equal(isDuplicateBrand(brands, 'different', ' sony '), true);
  assert.equal(isDuplicateBrand(brands, 'sony', 'Sony Updated', 'sony'), false);
  assert.deepEqual(sortBrandsAlphabetically([brands[1], brands[0]]).map((brand) => brand.id), ['legacy-brand', 'sony']);
  assert.equal(countProductsForBrand([product()], brands[0]), 1);
  assert.equal(countProductsForBrand([product({ brand: undefined, specs: { Brand: 'Sony', Display: 'OLED' } })], brands[0]), 1);
  assert.equal(resolveRegisteredBrandId(product({ brand: undefined, specs: { Brand: 'Sony' } }), brands), 'sony');
});

test('category blueprint safely normalizes subcategories and specification templates', () => {
  assert.deepEqual(normalizeSubcategories([
    { id: '', name: ' Smart Phones ' },
    { id: 'smart-phones', name: 'Duplicate' },
    { id: 'tv', name: ' Televisions ', isActive: false },
  ]), [
    { id: 'smart-phones', name: 'Smart Phones', isActive: true },
    { id: 'tv', name: 'Televisions', isActive: false },
  ]);
  assert.deepEqual(normalizeSpecificationTemplate([
    { name: ' RAM ', required: true },
    { name: 'ram' },
    { name: ' Storage ' },
  ]), [
    { name: 'RAM', required: true },
    { name: 'Storage', required: false },
  ]);
  assert.deepEqual(getActiveSubcategories(normalizeCategoryBlueprint(categories[0])).map((item) => item.id), ['phones']);
  assert.deepEqual(applySpecificationTemplate({ Existing: 'Value' }, categories[0].specificationTemplate), {
    Existing: 'Value', Display: '', Battery: '',
  });
});

test('legacy products receive safe editor defaults without changing the storefront contract', () => {
  const legacy = product({
    brand: undefined,
    subcategory: undefined,
    tags: undefined,
    keyFeatures: undefined,
    whatsIncluded: undefined,
    imageUrls: undefined,
    specs: { Brand: 'Sony', Display: 'LCD' },
  });
  const draft = normalizeProductForEditor(legacy, brands, categories);
  assert.equal(draft.brand, 'sony');
  assert.equal(draft.subcategory, '');
  assert.deepEqual(draft.tags, []);
  assert.deepEqual(draft.keyFeatures, []);
  assert.deepEqual(draft.whatsIncluded, []);
  assert.deepEqual(draft.imageUrls, []);
  assert.equal(draft.specs?.Display, 'LCD');
  assert.equal(draft.specs?.Battery, '');
});

test('product save payload protects system fields and derives launch metadata', () => {
  const now = '2026-07-19T10:00:00.000Z';
  const created = buildProductSavePayload({
    draft: {
      ...createProductDraft('electronics', 'ZY-2'),
      id: 'new-phone', name: ' New Phone ', brand: 'sony', subcategory: 'phones',
      price: 80, originalPrice: 100, stock: 3, imageUrl: ' https://example.com/new.jpg ',
      tags: [' phone ', 'phone'], keyFeatures: [' OLED '], whatsIncluded: [' Cable '],
      rating: 5, reviewsCount: 999, discount: 90, specs: { Display: ' OLED ' },
    },
    selectedBrand: brands[0],
    now,
  });
  assert.equal(created.rating, 0);
  assert.equal(created.reviewsCount, 0);
  assert.equal(created.discount, 20);
  assert.equal(created.createdAt, now);
  assert.equal(created.updatedAt, now);
  assert.deepEqual(created.tags, ['phone']);
  assert.equal(created.specs?.Brand, 'Sony');

  const stored = product({ createdAt: '2026-01-01T00:00:00.000Z' });
  const updated = buildProductSavePayload({
    draft: { ...stored, rating: 1, reviewsCount: 0, discount: 99, price: 90, originalPrice: 120 },
    storedProduct: stored,
    selectedBrand: brands[0],
    now,
  });
  assert.equal(updated.rating, 4.5);
  assert.equal(updated.reviewsCount, 9);
  assert.equal(updated.discount, 25);
  assert.equal(updated.createdAt, stored.createdAt);
  assert.equal(updated.updatedAt, now);
});

test('launch validation requires registered brand, matching subcategory and required specifications', () => {
  const valid = product();
  assert.deepEqual(validateProductForSave({ product: valid, products: [valid], categories, brands, editingProductId: valid.id }), []);

  const errors = validateProductForSave({
    product: product({ brand: 'unregistered', subcategory: 'other', barcode: 'ABC', specs: { Display: '' } }),
    products: [], categories, brands,
  });
  assert.deepEqual(errors, [
    'Selected sub category does not belong to the selected category.',
    'Required specification "Display" must have a value.',
    'Select an existing product brand.',
    'Barcode must contain 8 to 14 digits.',
  ]);

  assert.deepEqual(validateProductForSave({
    product: product({ subcategory: '', isActive: false }), products: [], categories, brands,
  }), ['Select a sub category for the selected category.']);
});

test('Sprint L2 Admin UI exposes controlled registries and preserves existing CRUD operations', () => {
  const admin = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  assert.match(admin, /Brand Registry/);
  assert.match(admin, /Select a registered brand/);
  assert.match(admin, /Specification Template/);
  assert.match(admin, /Sub Categories/);
  assert.match(admin, /buildProductSavePayload/);
  assert.match(admin, /splitProductData\(payload as Record<string, unknown>\)/);
  assert.match(admin, /productBatch\.set\(doc\(db, "products", productId\)/);
  assert.match(admin, /productBatch\.set\(commercialReference/);
  assert.match(admin, /productBatch\.delete\(doc\(db, PRODUCT_PRIVATE_COLLECTION, productToDelete\.id\)\)/);
  assert.doesNotMatch(admin, /rating:\s*editingProduct\s*\?\s*editingProduct\.rating\s*:\s*5/);
  assert.doesNotMatch(admin, /reviewsCount[^\n]*type=["'](?:number|text)["']/);
  assert.match(admin, /grid-cols-1[\s\S]*sm:grid-cols-2/);
});

test('Firestore rules expose brand metadata read-only to customers and reserve writes for admins', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const brandRules = rules.slice(rules.indexOf('match /brands/{brandId}'), rules.indexOf('// Users Rules'));
  assert.match(brandRules, /allow read: if true;/);
  assert.match(brandRules, /allow write: if isAdmin\(\);/);
});

test('the version-controlled permission matrix covers every Sprint L2 field', () => {
  const matrix = readFileSync('docs/PRODUCT_FIELD_PERMISSION_MATRIX.md', 'utf8');
  for (const field of [
    'brand', 'model', 'barcode', 'productType', 'subcategory', 'tags', 'shortDescription',
    'keyFeatures', 'whatsIncluded', 'imageUrl', 'imageUrls', 'updatedAt', 'rating',
    'reviewsCount', 'discount', 'specificationTemplate[].name',
  ]) {
    assert.equal(matrix.includes('`' + field + '`'), true, `Missing permission row for ${field}`);
  }
});
