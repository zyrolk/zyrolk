import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ProductParser } from '../functions/src/api/suppliers/a2z/ProductParser';
import {
  buildSupplierImportWarnings,
  detectSupplierProductDetailChanges,
  mergeSupplierCatalogDetails,
  mergeSupplierProductMetadata,
} from '../functions/src/api/suppliers/supplierProductImport';
import { filterSupplierComparison } from '../functions/src/scheduled/supplierSyncSettings';
import { buildSupplierProductApprovalBaseline, detectSupplierApprovalConflict } from '../functions/src/api/suppliers/supplierApprovalConcurrency';
import { buildSupplierReviewMetadataSections } from '../src/services/supplierReviewEditor';

const completeRawProduct = {
  pro_id: 7295,
  pro_code: 'A2Z-7295',
  ean: '4791234567890',
  pro_name: 'Premium Smart Watch',
  short_description: 'Compact supplier summary',
  pro_desc: 'Complete supplier description',
  brand_name: 'Samsung Mobile',
  manufacturer: 'Samsung Electronics',
  model_number: 'SM-WATCH-1',
  cat_name: 'Electronics',
  sub_category: 'Smart Watches',
  tags: ['wearable', 'smart'],
  search_keywords: 'watch, fitness',
  product_type: 'Wearable',
  collection_name: 'Launch 2026',
  attributes: { Colour: 'Black', Material: 'Aluminium' },
  variants: [{ sku: 'A2Z-7295-BLK', options: { Color: 'Black', Storage: '32GB' }, stock: 4 }],
  options: { Color: ['Black'], Storage: ['32GB'], RAM: ['4GB'], Capacity: ['420mAh'], Pattern: ['Solid'], Style: ['Sport'] },
  specifications: { Display: 'AMOLED', Warranty: '1 Year' },
  key_features: ['GPS', 'Heart-rate monitor'],
  dimensions: { length: 45, width: 40, height: 11, unit: 'mm' },
  product_weight: { value: 48, unit: 'g' },
  package_size: { length: 12, width: 9, height: 6, unit: 'cm' },
  shipping_class: 'small-parcel',
  warranty: { period: 12, unit: 'months' },
  country_of_origin: 'Vietnam',
  images: ['https://ayp.lk/storage/products/a2z/7295-front.jpg', 'https://ayp.lk/storage/products/a2z/7295-side.jpg'],
  video_urls: ['https://cdn.example.com/watch-demo.mp4'],
  selling_price: 19000,
  compare_price: 22000,
  wholesale_price: 15000,
  currency: 'LKR',
  tax: { rate: 18, included: true },
  discount_percent: 14,
  bal: 8,
  availability: 'in_stock',
  lead_time: '2 days',
  moq: 1,
  max_order_quantity: 5,
  visible: false,
  status: 'active',
  updated_at: '2026-07-24T10:00:00.000Z',
  created_at: '2026-07-01T10:00:00.000Z',
  slug: 'premium-smart-watch',
  meta_description: 'Premium smart watch supplied by A2Z.',
  customPayload: { exact: true, nested: ['one', 2, false] },
};

test('Sprint 5 imports every recognized supplier product field and preserves unknown values exactly', () => {
  const parsed = ProductParser.parseJsonPayload(completeRawProduct, 'https://ayp.lk');
  assert.equal(parsed.supplierProductId, '7295');
  assert.equal(parsed.sku, 'A2Z-7295');
  assert.equal(parsed.barcode, '4791234567890');
  assert.equal(parsed.title, 'Premium Smart Watch');
  assert.equal(parsed.shortDescription, 'Compact supplier summary');
  assert.equal(parsed.longDescription, 'Complete supplier description');
  assert.equal(parsed.brand, 'Samsung Mobile');
  assert.equal(parsed.manufacturer, 'Samsung Electronics');
  assert.equal(parsed.model, 'SM-WATCH-1');
  assert.deepEqual(parsed.categoryHierarchy, ['Electronics', 'Smart Watches']);
  assert.deepEqual(parsed.tags, ['wearable', 'smart']);
  assert.deepEqual(parsed.keywords, ['watch', 'fitness']);
  assert.equal(parsed.productType, 'Wearable');
  assert.equal(parsed.collection, 'Launch 2026');
  assert.deepEqual(parsed.attributes, completeRawProduct.attributes);
  assert.deepEqual(parsed.variants, completeRawProduct.variants);
  assert.deepEqual(parsed.options, completeRawProduct.options);
  assert.deepEqual(parsed.specifications, completeRawProduct.specifications);
  assert.deepEqual(parsed.features, completeRawProduct.key_features);
  assert.deepEqual(parsed.dimensions, completeRawProduct.dimensions);
  assert.deepEqual(parsed.weight, completeRawProduct.product_weight);
  assert.deepEqual(parsed.packageSize, completeRawProduct.package_size);
  assert.equal(parsed.shippingClass, 'small-parcel');
  assert.deepEqual(parsed.warranty, completeRawProduct.warranty);
  assert.equal(parsed.countryOfOrigin, 'Vietnam');
  assert.equal(parsed.mediaGallery.length, 3);
  assert.deepEqual(parsed.videoUrls, completeRawProduct.video_urls);
  assert.equal(parsed.price, 19000);
  assert.equal(parsed.comparePrice, 22000);
  assert.equal(parsed.costPrice, 15000);
  assert.equal(parsed.currency, 'LKR');
  assert.deepEqual(parsed.tax, completeRawProduct.tax);
  assert.equal(parsed.discount, 14);
  assert.equal(parsed.inventoryLevel, 8);
  assert.equal(parsed.availability, 'in_stock');
  assert.equal(parsed.leadTime, '2 days');
  assert.equal(parsed.minimumOrderQuantity, 1);
  assert.equal(parsed.maximumOrderQuantity, 5);
  assert.equal(parsed.visibility, false);
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.lastUpdated, completeRawProduct.updated_at);
  assert.equal(parsed.createdDate, completeRawProduct.created_at);
  assert.equal(parsed.slug, 'premium-smart-watch');
  assert.equal(parsed.metaDescription, completeRawProduct.meta_description);
  assert.deepEqual(parsed.extraAttributes, { customPayload: completeRawProduct.customPayload });
  assert.ok(parsed.providedFields?.includes('variants'));
  assert.ok(parsed.providedFields?.includes('stock'));
});

test('Sprint 5 does not fabricate optional supplier fields and survives canonical re-normalization', () => {
  const minimal = ProductParser.parseJsonPayload({ sku: 'MIN-1', title: 'Minimal product' });
  assert.equal(Object.hasOwn(minimal, 'brand'), false);
  assert.equal(Object.hasOwn(minimal, 'variants'), false);
  assert.equal(Object.hasOwn(minimal, 'videoUrls'), false);
  assert.equal(Object.hasOwn(minimal, 'extraAttributes'), false);
  assert.equal(minimal.providedFields?.includes('stock'), false);

  const first = ProductParser.parseJsonPayload(completeRawProduct, 'https://ayp.lk');
  const second = ProductParser.parseJsonPayload(first as unknown as Record<string, unknown>, 'https://ayp.lk');
  assert.deepEqual(second.extraAttributes, first.extraAttributes);
  assert.deepEqual(second.providedFields, first.providedFields);
  assert.deepEqual(second.variants, first.variants);
  assert.deepEqual(second.options, first.options);
});

test('Sprint 5 normalizes common top-level variant attributes without losing supplier-defined options', () => {
  const parsed = ProductParser.parseJsonPayload({
    sku: 'VAR-1', title: 'Variant product', color: 'Blue', size: 'Large', storage: '256GB', ram: '12GB',
    capacity: '500ml', pattern: 'Striped', style: 'Modern', options: { Finish: ['Matte'] },
  });
  assert.deepEqual(parsed.attributes, {
    Color: 'Blue', Size: 'Large', Storage: '256GB', RAM: '12GB', Capacity: '500ml', Pattern: 'Striped', Style: 'Modern',
  });
  assert.deepEqual(parsed.options, { Finish: ['Matte'] });
  assert.equal(parsed.extraAttributes, undefined);
});

test('Sprint 5 sparse updates preserve approved catalog and private supplier metadata values', () => {
  const sparse = ProductParser.parseJsonPayload({ sku: 'A2Z-1', title: 'Updated name', model: 'NEW-MODEL', customFlag: false });
  const existing = {
    shortDescription: 'Approved summary',
    model: 'OLD-MODEL',
    warranty: 'Existing warranty',
    supplierMetadata: { manufacturer: 'Existing maker', extraAttributes: { retained: 'yes' } },
  };
  assert.deepEqual(mergeSupplierCatalogDetails(sparse, existing, false), {
    shortDescription: 'Approved summary', model: 'OLD-MODEL', warranty: 'Existing warranty',
  });
  assert.deepEqual(mergeSupplierCatalogDetails(sparse, existing, true), {
    shortDescription: 'Approved summary', model: 'NEW-MODEL', warranty: 'Existing warranty',
  });
  assert.deepEqual(mergeSupplierProductMetadata(sparse, existing.supplierMetadata), {
    manufacturer: 'Existing maker',
    extraAttributes: { retained: 'yes', customFlag: false },
    sku: 'A2Z-1',
    title: 'Updated name',
    model: 'NEW-MODEL',
    providedFields: sparse.providedFields,
  });
});

test('Sprint 5 detects detail changes and routes them through the existing description-update control', () => {
  const product = ProductParser.parseJsonPayload({ sku: 'A2Z-1', title: 'Product', model: 'NEW', options: { Color: ['Black'] }, variants: [{ color: 'Black' }] });
  const changedFields = detectSupplierProductDetailChanges(product, {
    model: 'OLD', options: { Color: ['Blue'] }, variants: [{ color: 'Blue' }], supplierMetadata: {},
  });
  assert.deepEqual(changedFields, ['Model', 'Variants', 'Options']);
  assert.equal(filterSupplierComparison({ status: 'DESCRIPTION_CHANGED', changedFields }, { syncDescriptionUpdates: false }), null);
  assert.deepEqual(filterSupplierComparison({ status: 'DESCRIPTION_CHANGED', changedFields }, { syncDescriptionUpdates: true }), {
    status: 'DESCRIPTION_CHANGED', changedFields,
  });
});

test('Sprint 5 imported catalog details remain protected by optimistic concurrency', () => {
  const baselineProduct = { name: 'Product', stock: 2, variants: [{ color: 'Black' }], videoUrls: ['https://cdn.example.com/one.mp4'] };
  const baseline = buildSupplierProductApprovalBaseline('product-1', baselineProduct);
  const conflict = detectSupplierApprovalConflict(baseline, 'product-1', {
    ...baselineProduct,
    variants: [{ color: 'Blue' }],
  });
  assert.deepEqual(conflict?.changedFields, ['supplierDetails']);
  assert.deepEqual((conflict?.oldValues.supplierDetails as Record<string, unknown>).variants, [{ color: 'Black' }]);
});

test('Sprint 5 emits structured warnings for missing publication and incomplete variant data', () => {
  const product = ProductParser.parseJsonPayload({ sku: 'WARN-1', title: 'Warning product', options: { Color: ['Black'] } });
  const warnings = buildSupplierImportWarnings(product, { price: 0, category: '', brand: '', specs: {} });
  assert.deepEqual(warnings.map((warning) => warning.code), [
    'missing_images', 'missing_brand', 'missing_category', 'missing_price', 'missing_stock', 'missing_specifications', 'missing_variant_data',
  ]);
  assert.ok(warnings.every((warning) => warning.severity === 'warning'));
});

test('Sprint 5 review UI exposes all imported-data sections, media diagnostics, and warnings', () => {
  const parsed = ProductParser.parseJsonPayload(completeRawProduct, 'https://ayp.lk');
  const sections = buildSupplierReviewMetadataSections({
    id: 'queue-1', productName: parsed.title, supplierCode: parsed.sku, supplierName: 'A2Z', costPrice: parsed.wholesalePrice,
    marketPrice: parsed.recommendedRetailPrice, stock: parsed.inventoryLevel, supplierSnapshot: { ...parsed },
  });
  assert.deepEqual(sections.map((section) => section.title), [
    'Basic Information', 'Pricing', 'Inventory', 'Media', 'Managed Media', 'Category', 'Brand', 'Specifications',
    'Variants & Options', 'Shipping', 'SEO', 'Supplier Metadata', 'Extra Attributes',
  ]);
  assert.equal(sections.find((section) => section.id === 'extra-attributes')?.fields[0]?.label, 'customPayload');

  const editor = readFileSync('src/components/SupplierReviewEditorModal.tsx', 'utf8');
  assert.match(editor, /Complete imported supplier data/);
  assert.match(editor, /Import validation warnings/);
  assert.match(editor, /Image count:/);
  assert.match(editor, /Broken images:/);
  assert.match(editor, /Supplier video URLs/);
  assert.match(editor, /<details/);
});

test('Sprint 5 keeps Sprint 1–4 authority, concurrency, traversal, and mapping paths connected', () => {
  const sourceUi = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(sourceUi, /postSupplierApi\('\/api\/supplier-sources'/);
  assert.match(approval, /detectSupplierApprovalConflict/);
  assert.match(approval, /reconcileSupplierApprovalStock/);
  assert.match(sync, /runSupplierCatalogTraversal/);
  assert.match(sync, /suggestSupplierCategory/);
  assert.match(sync, /suggestSupplierBrand/);
});
