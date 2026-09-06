import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createSupplierReviewDraft,
  updateSupplierReviewDraftField,
  validateSupplierReviewDraft,
  type SupplierReviewSourceItem,
} from '../src/services/supplierReviewEditor';
import {
  projectSupplierReviewCatalogTaxonomy,
  supplierReviewValidCategoryIds,
} from '../src/services/supplierReviewCatalog';
import {
  suggestSupplierBrand,
  suggestSupplierCategory,
} from '../functions/src/api/suppliers/supplierProductMapping';
import { projectSupplierReviewCatalogRecords as projectCatalogRecords } from '../functions/src/api/suppliers/supplierReviewCatalog';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const managedImage = 'https://firebasestorage.googleapis.com/v0/b/demo/o/supplier-media%2Fmanaged.webp?alt=media';

const catalogCategories = [
  {
    id: 'electronics',
    data: {
      name: 'Electronics',
      isActive: true,
      subcategories: [
        { id: 'kitchen', name: 'Kitchen', isActive: true },
        { id: 'legacy', name: 'Legacy', isActive: false },
      ],
      specificationTemplate: [{ name: 'Model', required: true }],
    },
  },
  {
    id: 'retired',
    data: { name: 'Retired', isActive: false, subcategories: [] },
  },
];

const catalogBrands = [
  { id: 'registered-brand', data: { name: 'Registered Brand', isActive: true } },
  { id: 'inactive-brand', data: { name: 'Inactive Brand', isActive: false } },
];

const taxonomy = projectCatalogRecords(catalogCategories, catalogBrands);
const clientTaxonomy = projectSupplierReviewCatalogTaxonomy({
  success: true,
  catalog: {
    categories: taxonomy.categories,
    brands: taxonomy.brands,
  },
});

const reviewItem = {
  id: 'dropex-0051',
  status: 'Pending',
  queueState: 'review_pending',
  supplierCode: '0051',
  productName: 'Paint Zoom',
  supplierOfferPendingRevision: 'rev-1',
  imageUrl: managedImage,
  costPrice: 1000,
  marketPrice: 1500,
  stock: 5,
  comparison: { comparisonStatus: 'NEW_PRODUCT' },
  productValidation: { readyToPublish: false, missingFields: ['category', 'brand'], errors: [] },
  managedMedia: [{ firebaseStorageUrl: managedImage, isPrimary: true, sortOrder: 0 }],
  categoryMapping: {
    supplierCategory: '',
    autoSelected: false,
    requiresManualSelection: true,
    targetCategoryId: '',
    targetSubcategoryId: '',
  },
  brandMapping: {
    supplierBrand: '',
    autoSelected: false,
    requiresManualSelection: true,
    mappedBrandId: '',
  },
  productPayload: {
    id: 'product-0051',
    name: 'Paint Zoom',
    description: 'Professional painter',
    price: 1500,
    category: '',
    rating: 0,
    reviewsCount: 0,
    stock: 5,
    imageUrl: managedImage,
    specs: {},
  },
} as SupplierReviewSourceItem;

test('active categories and brands appear in authoritative review catalog projection', () => {
  assert.deepEqual(taxonomy.categories.map((category) => category.id), ['electronics']);
  assert.deepEqual(taxonomy.brands.map((brand) => brand.id), ['registered-brand']);
  assert.deepEqual(clientTaxonomy.categories.map((category) => category.id), ['electronics']);
  assert.deepEqual(supplierReviewValidCategoryIds(clientTaxonomy.categories), ['electronics']);
});

test('inactive categories and brands are excluded from review catalog selectors', () => {
  assert.equal(taxonomy.categories.some((category) => category.id === 'retired'), false);
  assert.equal(taxonomy.brands.some((brand) => brand.id === 'inactive-brand'), false);
});

test('category selection exposes only active subcategories for the editor cascade', () => {
  const category = clientTaxonomy.categories[0];
  const activeSubcategories = (category.subcategories || []).filter((subcategory) => subcategory.isActive !== false);
  assert.deepEqual(activeSubcategories.map((subcategory) => subcategory.id), ['kitchen']);
});

test('supplied supplier category and brand auto-map only on exact active matches', () => {
  const mappedCategories = taxonomy.categories.map((category) => ({
    id: category.id,
    name: category.name,
    isActive: category.isActive,
    subcategories: category.subcategories,
    specificationTemplate: category.specificationTemplate,
  }));
  const mappedBrands = taxonomy.brands.map((brand) => ({ id: brand.id, name: brand.name, isActive: brand.isActive }));

  const category = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Electronics'],
    categories: mappedCategories,
  });
  const brand = suggestSupplierBrand({
    sourceId: 'dropex',
    supplierBrand: 'Registered Brand',
    brands: mappedBrands,
  });

  assert.equal(category.targetCategoryId, 'electronics');
  assert.equal(category.autoSelected, true);
  assert.equal(brand.mappedBrandId, 'registered-brand');
  assert.equal(brand.autoSelected, true);
});

test('admin can override auto-mapped category and brand values in the review draft', () => {
  const autoMappedItem = {
    ...reviewItem,
    categoryMapping: {
      supplierCategory: 'Electronics',
      autoSelected: true,
      requiresManualSelection: false,
      targetCategoryId: 'electronics',
      targetSubcategoryId: 'kitchen',
    },
    brandMapping: {
      supplierBrand: 'Registered Brand',
      autoSelected: true,
      requiresManualSelection: false,
      mappedBrandId: 'registered-brand',
    },
  };
  const draft = createSupplierReviewDraft(autoMappedItem);
  assert.equal(draft.category, 'electronics');
  assert.equal(draft.brand, 'registered-brand');

  const overridden = updateSupplierReviewDraftField(
    updateSupplierReviewDraftField(draft, 'category', { category: 'electronics', subcategory: '' }),
    'brand',
    { brand: 'registered-brand' },
  );
  assert.equal(overridden.category, 'electronics');
  assert.equal(overridden.brand, 'registered-brand');
});

test('missing supplier category and brand leaves mapping unresolved but manual selectors still work', () => {
  const draft = createSupplierReviewDraft(reviewItem);
  assert.equal(draft.category, '');
  assert.equal(draft.brand, '');

  const manualDraft = updateSupplierReviewDraftField(
    updateSupplierReviewDraftField(draft, 'category', { category: 'electronics', subcategory: 'kitchen' }),
    'brand',
    { brand: 'registered-brand' },
  );
  const errors = validateSupplierReviewDraft(
    manualDraft,
    supplierReviewValidCategoryIds(clientTaxonomy.categories),
    clientTaxonomy.categories,
    clientTaxonomy.brands,
  );
  assert.equal(errors.category, undefined);
  assert.equal(errors.brand, undefined);
});

test('review catalog loading does not auto-create categories or brands', () => {
  const sync = projectFile('functions/src/scheduled/supplierSync.ts');
  const catalog = projectFile('functions/src/api/suppliers/supplierReviewCatalog.ts');
  assert.doesNotMatch(sync, /collection\("categories"\)\.doc\([^)]*\)\.set/);
  assert.doesNotMatch(catalog, /\.set\(/u);
});

test('approval remains blocked until required mappings are valid', () => {
  const unresolved = validateSupplierReviewDraft(
    createSupplierReviewDraft(reviewItem),
    supplierReviewValidCategoryIds(clientTaxonomy.categories),
    clientTaxonomy.categories,
    clientTaxonomy.brands,
  );
  assert.match(unresolved.category || '', /required/i);
  assert.match(unresolved.brand || '', /active registered brand/i);
});

test('supplier hub loads review catalog through the admin API instead of direct Firestore listeners', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.match(hub, /\/api\/supplier-review-catalog/u);
  assert.match(hub, /projectSupplierReviewCatalogTaxonomy/u);
  assert.doesNotMatch(hub, /onSnapshot\(\s*collection\(db, ["']categories["']\)/u);
  assert.doesNotMatch(hub, /onSnapshot\(\s*collection\(db, ["']brands["']\)/u);
});

test('review editor category and brand selects filter to active catalog entries', () => {
  const editor = projectFile('src/components/SupplierReviewEditorModal.tsx');
  assert.match(editor, /categories\.filter\(\(category\) => category\.isActive !== false\)/u);
  assert.match(editor, /brands\.filter\(\(brand\) => brand\.isActive !== false\)/u);
  assert.match(editor, /\(selectedCategory\?\.subcategories \|\| \[\]\)\.filter\(\(subcategory\) => subcategory\.isActive !== false\)/u);
});
