import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applySupplierProductFieldOwnership,
} from '../functions/src/api/suppliers/supplierFieldOwnership';
import {
  buildAutoProductSku,
  parseSupplierApprovalDraft,
} from '../functions/src/api/suppliers/supplierApproval';
import {
  createSupplierReviewDraft,
  updateSupplierReviewDraftField,
} from '../src/services/supplierReviewEditor';
import {
  containsCommercialProductFields,
  splitProductData,
} from '../src/services/products/productCommercialData';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const reviewItem = {
  id: 'queue-phone',
  productName: 'Supplier Phone',
  supplierCode: 'A2Z-PHONE-1',
  supplierName: 'A2Z Traders',
  costPrice: 80_000,
  marketPrice: 120_000,
  stock: 5,
  imageUrl: 'https://supplier.example/phone.jpg',
  comparison: { comparisonStatus: 'NEW_PRODUCT', fieldChanges: [] },
  productPayload: {
    id: 'supplier-phone', name: 'Supplier Phone', description: 'Supplier description', price: 110_000,
    originalPrice: 120_000, costPrice: 80_000, marketPrice: 120_000,
    imageUrl: 'https://supplier.example/phone.jpg', imageUrls: ['https://supplier.example/phone.jpg'],
    category: 'phones', brand: 'brand-1', specs: {}, stock: 5, rating: 0, reviewsCount: 0,
    sku: 'A2Z-PHONE-1', supplierItemCode: 'A2Z-PHONE-1',
  },
};

test('internal identifiers and commercial prices are excluded from public product documents', () => {
  const { publicData, commercialData } = splitProductData({
    id: 'phone', name: 'Phone', price: 110_000, sku: 'ZY-000001', supplierItemCode: 'A2Z-PHONE-1',
    costPrice: 80_000, marketPrice: 120_000,
  });
  assert.equal(containsCommercialProductFields(publicData), false);
  assert.equal(Object.hasOwn(publicData, 'sku'), false);
  assert.deepEqual(
    { sku: commercialData.sku, supplierItemCode: commercialData.supplierItemCode, costPrice: commercialData.costPrice, marketPrice: commercialData.marketPrice },
    { sku: 'ZY-000001', supplierItemCode: 'A2Z-PHONE-1', costPrice: 80_000, marketPrice: 120_000 },
  );
  assert.match(projectFile('firestore.rules'), /'sku', 'supplierItemCode'/);
});

test('supplier review exposes editable admin commercial values without changing supplier identity', () => {
  const draft = createSupplierReviewDraft(reviewItem);
  assert.equal(draft.productSku, '');
  assert.equal(draft.supplierItemCode, 'A2Z-PHONE-1');
  assert.equal(draft.costPrice, 80_000);
  assert.equal(draft.marketPrice, 120_000);
  const edited = updateSupplierReviewDraftField(draft, 'costPrice', { costPrice: 82_500 });
  assert.equal(edited.costPrice, 82_500);
  assert.equal(edited.fieldOwnership.costPrice, 'admin');
  assert.deepEqual(edited.editedFields, ['costPrice']);

  const parsed = parseSupplierApprovalDraft({
    ...edited,
    primaryImageUrl: 'https://supplier.example/phone.jpg',
    galleryImageUrls: [],
  });
  assert.equal(parsed?.costPrice, 82_500);
  assert.equal(parsed?.marketPrice, 120_000);
  assert.equal(parsed?.fieldOwnership?.costPrice, 'admin');
});

test('future supplier approvals preserve administrator-owned commercial values', () => {
  const timestamp = '2026-07-28T00:00:00.000Z';
  const result = applySupplierProductFieldOwnership({
    proposedProduct: { name: 'Phone', costPrice: 79_000, marketPrice: 118_000 },
    currentProduct: { name: 'Phone', costPrice: 82_500, marketPrice: 121_000 },
    existingOwnership: {
      costPrice: { owner: 'admin', sourceId: null, updatedAt: timestamp, updatedBy: 'admin', reason: 'review_decision' },
      marketPrice: { owner: 'admin', sourceId: null, updatedAt: timestamp, updatedBy: 'admin', reason: 'review_decision' },
    },
    reviewerId: 'admin', sourceId: 'a2z-traders', timestamp,
  });
  assert.equal(result.product.costPrice, 82_500);
  assert.equal(result.product.marketPrice, 121_000);
});

test('new supplier products receive a deterministic Zyro SKU only during approval', () => {
  assert.equal(buildAutoProductSku('supplier-phone'), buildAutoProductSku('supplier-phone'));
  assert.notEqual(buildAutoProductSku('supplier-phone'), buildAutoProductSku('supplier-phone-2'));
  assert.match(buildAutoProductSku('supplier-phone'), /^ZY-[A-F0-9]{12}$/u);
  const sync = projectFile('functions/src/scheduled/supplierSync.ts');
  assert.match(sync, /sku: match\?\.sku \|\| ""/);
  assert.match(sync, /supplierItemCode: product\.sku/);
});

test('manual products are explicitly internal while supplier review controls stay private', () => {
  const admin = projectFile('src/components/AdminDashboard.tsx');
  const review = projectFile('src/components/SupplierReviewEditorModal.tsx');
  const card = projectFile('src/components/ProductCard.tsx');
  const detail = projectFile('src/components/ProductDetailModal.tsx');
  const seo = projectFile('src/services/seo/storefrontSeo.ts');

  assert.match(admin, /Product SKU[\s\S]*Admin Only · Read-Only/);
  assert.match(admin, /Manual products are fulfilled internally/);
  assert.doesNotMatch(admin, /Assigned Supplier/);
  assert.doesNotMatch(admin, /Supplier Code[\s\S]*Admin Only/);
  assert.match(review, /Zyro SKU[\s\S]*Auto-assigned on approval/);
  assert.match(review, /Cost Price[\s\S]*Admin only/);
  assert.match(review, /Market Price[\s\S]*Admin only/);
  assert.doesNotMatch(card, /product\.sku/);
  assert.doesNotMatch(detail, /product\.sku/);
  assert.doesNotMatch(seo, /product\.sku/);
});
