import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySupplierProductFieldOwnership,
  parseSupplierProductFieldOwnershipDecision,
  SUPPLIER_PRODUCT_OWNERSHIP_FIELDS,
} from '../functions/src/api/suppliers/supplierFieldOwnership';
import { buildSupplierProductComparison } from '../functions/src/api/suppliers/supplierProductImport';
import { ProductParser } from '../functions/src/api/suppliers/a2z/ProductParser';
import { parseSupplierApprovalDraft } from '../functions/src/api/suppliers/supplierApproval';
import {
  createSupplierReviewDraft,
  setSupplierReviewDraftFieldOwner,
  updateSupplierReviewDraftField,
} from '../src/services/supplierReviewEditor';
import {
  changedProductOwnershipFields,
  claimAdminProductFieldOwnership,
} from '../src/services/products/supplierFieldOwnership';

const timestamp = '2026-07-26T12:00:00.000Z';

test('Sprint 2 ownership contract covers every Supplier Review editable destination', () => {
  for (const field of [
    'name', 'shortDescription', 'description', 'model', 'barcode', 'productType', 'tags', 'keyFeatures',
    'whatsIncluded', 'slug', 'price', 'originalPrice', 'costPrice', 'marketPrice', 'stock', 'category', 'subcategory', 'brand', 'specs',
    'isActive', 'isNew', 'isFeatured', 'isBestSeller', 'imageUrl', 'imageUrls',
  ]) assert.ok(SUPPLIER_PRODUCT_OWNERSHIP_FIELDS.includes(field), field);
  assert.throws(() => parseSupplierProductFieldOwnershipDecision({ rating: 'supplier' }), /ownership is invalid/i);
  assert.throws(() => parseSupplierProductFieldOwnershipDecision({ name: 'system' }), /ownership is invalid/i);
});

test('expanded review parity fields and ownership decisions are validated server-side', () => {
  const parsed = parseSupplierApprovalDraft({
    productName: 'Phone', shortDescription: 'Summary', description: 'Full copy', model: 'X1', barcode: '12345678',
    productType: 'Smartphone', tags: ['mobile'], keyFeatures: ['5G'], whatsIncluded: ['Cable'], slug: 'phone-x1',
    sellingPrice: 100, comparePrice: 120, stock: 4, category: 'phones', subcategory: 'smartphones', brand: 'brand-1',
    specifications: { RAM: '8 GB' }, isActive: true, isNew: true, isFeatured: false, isBestSeller: false,
    primaryImageUrl: 'https://supplier.example/phone.jpg', galleryImageUrls: [],
    fieldOwnership: { name: 'admin', price: 'supplier', specs: 'admin' }, editedFields: ['name', 'specs'],
  });
  assert.equal(parsed?.shortDescription, 'Summary');
  assert.deepEqual(parsed?.tags, ['mobile']);
  assert.deepEqual(parsed?.fieldOwnership, { name: 'admin', price: 'supplier', specs: 'admin' });
  assert.deepEqual(parsed?.editedFields, ['name', 'specs']);
  assert.throws(() => parseSupplierApprovalDraft({
    productName: 'Phone', sellingPrice: 100, comparePrice: 100, stock: 1, category: 'phones', brand: 'brand-1',
    isActive: true, primaryImageUrl: 'https://supplier.example/phone.jpg', galleryImageUrls: [],
    fieldOwnership: { rating: 'supplier' },
  }), /ownership is invalid/i);
});

test('new supplier products initialize imported fields as supplier-owned and merchandising as admin-owned', () => {
  const item = {
    id: 'queue-new', productName: 'Supplier Phone', supplierCode: 'PHONE-1', costPrice: 1, marketPrice: 2, stock: 3,
    comparison: { comparisonStatus: 'NEW_PRODUCT', fieldChanges: [] },
    productPayload: {
      id: 'supplier-phone', name: 'Supplier Phone', description: 'Imported', price: 2, originalPrice: 2,
      imageUrl: 'https://supplier.example/phone.jpg', imageUrls: ['https://supplier.example/phone.jpg'],
      category: 'phones', brand: 'brand-1', specs: {}, stock: 3, rating: 0, reviewsCount: 0,
    },
  };
  const draft = createSupplierReviewDraft(item);
  assert.equal(draft.fieldOwnership.name, 'supplier');
  assert.equal(draft.fieldOwnership.price, 'supplier');
  assert.equal(draft.fieldOwnership.imageUrl, 'supplier');
  assert.equal(draft.fieldOwnership.isFeatured, 'admin');
});

test('legacy approved products fail safe and preserve live admin values without a migration', () => {
  const result = applySupplierProductFieldOwnership({
    proposedProduct: { name: 'Supplier title', description: 'Supplier copy', price: 120, stock: 7 },
    currentProduct: { name: 'Admin title', description: 'Admin copy', price: 150, stock: 5 },
    reviewerId: 'admin-1', timestamp, sourceId: 'a2z',
  });
  assert.deepEqual(
    { name: result.product.name, description: result.product.description, price: result.product.price, stock: result.product.stock },
    { name: 'Admin title', description: 'Admin copy', price: 150, stock: 5 },
  );
  assert.equal(result.ownership.name.owner, 'admin');
  assert.equal(result.ownership.price.owner, 'admin');
});

test('explicit supplier ownership updates only the selected field', () => {
  const result = applySupplierProductFieldOwnership({
    proposedProduct: { name: 'Supplier title', description: 'Supplier copy', price: 120 },
    currentProduct: { name: 'Admin title', description: 'Admin copy', price: 150 },
    requestedOwnership: { name: 'admin', description: 'admin', price: 'supplier' },
    reviewerId: 'admin-1', timestamp, sourceId: 'a2z',
  });
  assert.equal(result.product.name, 'Admin title');
  assert.equal(result.product.description, 'Admin copy');
  assert.equal(result.product.price, 120);
  assert.equal(result.ownership.price.owner, 'supplier');
  assert.equal(result.ownership.price.sourceId, 'a2z');
});

test('review edits claim admin ownership while an explicit decision can return ownership to supplier', () => {
  const item = {
    id: 'queue-edit', productName: 'Supplier Phone', supplierCode: 'PHONE-1', costPrice: 1, marketPrice: 2, stock: 3,
    productPayload: {
      id: 'supplier-phone', name: 'Supplier Phone', description: 'Imported', price: 2, originalPrice: 2,
      imageUrl: 'https://supplier.example/phone.jpg', imageUrls: ['https://supplier.example/phone.jpg'],
      category: 'phones', brand: 'brand-1', specs: {}, stock: 3, rating: 0, reviewsCount: 0,
      supplierFieldOwnership: { name: { owner: 'supplier' } },
    },
  };
  const initial = createSupplierReviewDraft(item);
  const edited = updateSupplierReviewDraftField(initial, 'name', { productName: 'Admin Phone' });
  assert.equal(edited.fieldOwnership.name, 'admin');
  assert.deepEqual(edited.editedFields, ['name']);
  const returned = setSupplierReviewDraftFieldOwner(edited, 'name', 'supplier');
  assert.equal(returned.fieldOwnership.name, 'supplier');
});

test('manual Product Editor claims only fields changed by the admin', () => {
  const previous = { name: 'Phone', description: 'Old', price: 100, stock: 5 };
  const next = { name: 'Phone', description: 'Admin copy', price: 100, stock: 5 };
  const changed = changedProductOwnershipFields(previous, next, ['name', 'description', 'price', 'stock']);
  assert.deepEqual(changed, ['description']);
  const ownership = claimAdminProductFieldOwnership(
    { price: { owner: 'supplier', sourceId: 'a2z', updatedAt: timestamp, updatedBy: 'admin', reason: 'review_decision' } },
    changed,
    'admin-1',
    timestamp,
  );
  assert.equal(ownership.description.owner, 'admin');
  assert.equal(ownership.price.owner, 'supplier');
});

test('repeated syncs preserve an admin edit and advance the supplier comparison baseline', () => {
  const unchangedSupplier = ProductParser.parseJsonPayload({ sku: 'PHONE-1', title: 'Supplier Phone', stock: 5, price: 100 });
  const existing = {
    id: 'phone-1', name: 'Admin Phone', stock: 5,
    supplierMetadata: { sku: 'PHONE-1', title: 'Supplier Phone', inventoryLevel: 5, price: 100 },
  };
  assert.equal(buildSupplierProductComparison(unchangedSupplier, existing).fieldChanges.some((change) => change.field === 'title'), false);

  const changedSupplier = ProductParser.parseJsonPayload({ sku: 'PHONE-1', title: 'Supplier Phone V2', stock: 5, price: 100 });
  const comparison = buildSupplierProductComparison(changedSupplier, existing);
  assert.equal(comparison.fieldChanges.some((change) => change.field === 'title'), true);

  const approved = applySupplierProductFieldOwnership({
    proposedProduct: {
      ...existing,
      name: 'Supplier Phone V2',
      supplierMetadata: { sku: 'PHONE-1', title: 'Supplier Phone V2', inventoryLevel: 5, price: 100 },
    },
    currentProduct: { id: 'phone-1', name: 'Admin Phone', stock: 5 },
    existingOwnership: { name: { owner: 'admin', sourceId: null, updatedAt: timestamp, updatedBy: 'admin-1', reason: 'admin_product_edit' } },
    reviewerId: 'admin-1', timestamp, sourceId: 'a2z',
  });
  assert.equal(approved.product.name, 'Admin Phone');
  assert.equal((approved.product.supplierMetadata as { title: string }).title, 'Supplier Phone V2');
  assert.equal(buildSupplierProductComparison(changedSupplier, approved.product).fieldChanges.some((change) => change.field === 'title'), false);
});
