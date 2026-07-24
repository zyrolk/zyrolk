import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeSupplierMappingValue,
  StoreBrandMappingCandidate,
  StoreCategoryMappingCandidate,
  suggestSupplierBrand,
  suggestSupplierCategory,
  supplierMappingDocumentId,
  validateSupplierProductForApproval,
} from '../functions/src/api/suppliers/supplierProductMapping';
import { parseSupplierApprovalDraft } from '../functions/src/api/suppliers/supplierApproval';

const categories: StoreCategoryMappingCandidate[] = [
  {
    id: 'phones',
    name: 'Mobile Phones',
    keywords: ['phone', 'smartphone', 'mobile'],
    subcategories: [{ id: 'smartphones', name: 'Smartphones' }, { id: 'feature-phones', name: 'Feature Phones' }],
    specificationTemplate: [
      { name: 'RAM', required: true },
      { name: 'Storage', required: true },
      { name: 'Color' },
    ],
  },
  {
    id: 'shoes',
    name: 'Shoes',
    keywords: ['shoe', 'footwear'],
    subcategories: [{ id: 'sports-shoes', name: 'Sports Shoes' }],
    specificationTemplate: [{ name: 'Size', required: true }, { name: 'Material', required: true }],
  },
];

const brands: StoreBrandMappingCandidate[] = [
  { id: 'samsung', name: 'Samsung', aliases: ['Samsung Electronics'] },
  { id: 'nike', name: 'Nike' },
  { id: 'disabled', name: 'Disabled Brand', isActive: false },
];

test('Sprint 4 exact and normalized category matches auto-select with production confidence', () => {
  const exact = suggestSupplierCategory({ sourceId: 'a2z', supplierCategories: ['Mobile Phones'], categories });
  assert.equal(exact.targetCategoryId, 'phones');
  assert.equal(exact.mappingType, 'exact');
  assert.equal(exact.confidence, 100);
  assert.equal(exact.autoSelected, true);

  const normalized = suggestSupplierCategory({ sourceId: 'a2z', supplierCategories: [' mobile_phones '], categories });
  assert.equal(normalized.targetCategoryId, 'phones');
  assert.equal(normalized.mappingType, 'normalized');
  assert.equal(normalized.confidence, 98);
  assert.equal(normalized.autoSelected, true);
});

test('Sprint 4 source-specific manual mapping outranks global fallback and preserves subcategory', () => {
  const mappings = [
    {
      sourceId: 'global', supplierCategory: 'Handsets', normalizedCategory: 'handsets', targetCategoryId: 'shoes',
      targetSubcategoryId: 'sports-shoes', confidence: 100, mappingType: 'manual' as const, version: 8, updatedBy: 'admin-global',
    },
    {
      sourceId: 'a2z', supplierCategory: 'Handsets', normalizedCategory: 'handsets', targetCategoryId: 'phones',
      targetSubcategoryId: 'smartphones', confidence: 100, mappingType: 'learned' as const, version: 2, updatedBy: 'admin-source',
    },
  ];
  const source = suggestSupplierCategory({ sourceId: 'a2z', supplierCategories: ['Handsets'], categories, mappings });
  assert.equal(source.targetCategoryId, 'phones');
  assert.equal(source.targetSubcategoryId, 'smartphones');
  assert.equal(source.mappingSource, 'source');
  assert.equal(source.mappingType, 'learned');

  const fallback = suggestSupplierCategory({ sourceId: 'another-source', supplierCategories: ['Handsets'], categories, mappings });
  assert.equal(fallback.targetCategoryId, 'shoes');
  assert.equal(fallback.mappingSource, 'global');
});

test('Sprint 4 keyword suggestions remain recommendations and uncertain results require manual selection', () => {
  const recommendation = suggestSupplierCategory({
    sourceId: 'a2z', supplierCategories: ['Technology'], productTitle: 'Galaxy smartphone 128GB', productType: 'phone', categories,
  });
  assert.equal(recommendation.targetCategoryId, 'phones');
  assert.ok(recommendation.confidence >= 80 && recommendation.confidence <= 94);
  assert.equal(recommendation.autoSelected, false);
  assert.equal(recommendation.requiresManualSelection, false);

  const unknown = suggestSupplierCategory({ sourceId: 'a2z', supplierCategories: ['Miscellaneous'], productTitle: 'Unclassified item', categories });
  assert.ok(unknown.confidence < 80);
  assert.equal(unknown.autoSelected, false);
  assert.equal(unknown.requiresManualSelection, true);
});

test('Sprint 4 brand normalization maps case, aliases, and generic supplier suffixes', () => {
  for (const supplierBrand of ['Samsung', 'SAMSUNG', 'Samsung Electronics', 'Samsung Mobile']) {
    const result = suggestSupplierBrand({ sourceId: 'a2z', supplierBrand, brands });
    assert.equal(result.mappedBrandId, 'samsung', supplierBrand);
    assert.ok(result.confidence >= 95);
    assert.equal(result.autoSelected, true);
  }
  const missing = suggestSupplierBrand({ sourceId: 'a2z', supplierBrand: 'Unknown Factory', brands });
  assert.equal(missing.mappedBrandId, '');
  assert.equal(missing.requiresManualSelection, true);
});

test('Sprint 4 source-specific brand mapping overrides registry inference', () => {
  const result = suggestSupplierBrand({
    sourceId: 'supplier-a', supplierBrand: 'Galaxy Brand', brands,
    mappings: [
      { sourceId: 'global', supplierBrand: 'Galaxy Brand', normalizedBrand: 'galaxy brand', mappedBrandId: 'nike', confidence: 100, mappingType: 'manual', version: 1, updatedBy: 'global-admin' },
      { sourceId: 'supplier-a', supplierBrand: 'Galaxy Brand', normalizedBrand: 'galaxy brand', mappedBrandId: 'samsung', confidence: 100, mappingType: 'learned', version: 1, updatedBy: 'source-admin' },
    ],
  });
  assert.equal(result.mappedBrandId, 'samsung');
  assert.equal(result.mappingSource, 'source');
});

test('Sprint 4 approval validation enforces category-specific templates and all publication fields', () => {
  const valid = {
    name: 'Galaxy Phone', imageUrl: 'https://supplier.example/phone.jpg', category: 'phones', subcategory: 'smartphones',
    brand: 'samsung', price: 120_000, stock: 4, visible: true, specs: { ram: '8 GB', Storage: '128 GB' },
  };
  assert.deepEqual(validateSupplierProductForApproval(valid, categories, brands), []);

  const errors = validateSupplierProductForApproval({
    name: '', imageUrl: '', category: 'phones', subcategory: 'sports-shoes', brand: 'unknown', price: 0, stock: -1, specs: { RAM: '' },
  }, categories, brands);
  assert.deepEqual(new Set(errors.map((error) => error.field)), new Set([
    'name', 'imageUrl', 'price', 'stock', 'visibility', 'subcategory', 'specs.RAM', 'specs.Storage', 'brand',
  ]));

  const shoesErrors = validateSupplierProductForApproval({ ...valid, category: 'shoes', subcategory: 'sports-shoes', brand: 'nike', specs: { Size: '42' } }, categories, brands);
  assert.deepEqual(shoesErrors.map((error) => error.field), ['specs.Material']);
});

test('Sprint 4 approval drafts accept bounded subcategory and specification overrides', () => {
  const draft = parseSupplierApprovalDraft({
    productName: 'Galaxy Phone', sellingPrice: 120_000, comparePrice: 130_000, stock: 4,
    category: 'phones', subcategory: 'smartphones', brand: 'samsung', specifications: { RAM: '8 GB', Storage: '128 GB' },
    isActive: true, primaryImageUrl: 'https://supplier.example/phone.jpg', galleryImageUrls: [],
  });
  assert.equal(draft?.subcategory, 'smartphones');
  assert.deepEqual(draft?.specifications, { RAM: '8 GB', Storage: '128 GB' });
  assert.throws(() => parseSupplierApprovalDraft({ ...draft, specifications: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`Field ${index}`, 'value'])) }), /specifications are invalid/i);
});

test('Sprint 4 learned mapping IDs are stable and approval persists immutable mapping audit history', () => {
  assert.equal(normalizeSupplierMappingValue(' Phones_And-Tablets '), 'phones and tablets');
  assert.equal(supplierMappingDocumentId('source-a', 'phones'), supplierMappingDocumentId('source-a', 'phones'));
  assert.notEqual(supplierMappingDocumentId('source-a', 'phones'), supplierMappingDocumentId('source-b', 'phones'));

  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  assert.match(approval, /supplier_category_mappings/);
  assert.match(approval, /supplier_brand_mappings/);
  assert.match(approval, /mappingType: "learned"/);
  assert.match(approval, /supplier_mapping_audit/);
  assert.match(approval, /validationErrors/);
  assert.match(approval, /transaction\.create/);
  assert.match(approval, /version = Math\.max\(0, Number\(previous\.version\) \|\| 0\) \+ 1/);
});

test('Sprint 4 queue UX exposes suggestion acceptance, confidence, missing fields, and dynamic specifications', () => {
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const editor = readFileSync('src/components/SupplierReviewEditorModal.tsx', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(sync, /suggestSupplierCategory/);
  assert.match(sync, /suggestSupplierBrand/);
  assert.match(sync, /readyToPublish/);
  assert.match(hub, /Catalog readiness/);
  assert.match(editor, /Accept category suggestion/);
  assert.match(editor, /Accept brand suggestion/);
  assert.match(editor, /Category specifications/);
  assert.match(editor, /Ready to publish/);
});

test('Sprint 4 mapping collections remain server-authoritative', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  for (const collectionName of ['supplier_category_mappings', 'supplier_brand_mappings', 'supplier_mapping_audit']) {
    const start = rules.indexOf(`match /${collectionName}/{docId}`);
    assert.ok(start >= 0, collectionName);
    const block = rules.slice(start, start + 220);
    assert.match(block, /allow read: if isSupplierHubAdmin\(\)/);
    assert.match(block, /allow create, update, delete: if false/);
  }
});
