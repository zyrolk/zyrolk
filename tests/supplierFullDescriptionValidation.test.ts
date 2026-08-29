import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApiError } from '../functions/src/api/errors';
import {
  parseSupplierApprovalDraft,
} from '../functions/src/api/suppliers/supplierApproval';
import {
  resolveSupplierFullDescription,
  sanitizeSupplierProductDraft,
  SUPPLIER_FULL_DESCRIPTION_REQUIRED_MESSAGE,
  SUPPLIER_PORTAL_FULL_DESCRIPTION_MAX_LENGTH,
  validateSupplierProductForSubmission,
} from '../functions/src/api/suppliers/supplierPortalLogic';
import { validateSupplierReviewDraft, createSupplierReviewDraft } from '../src/services/supplierReviewEditor';

const category = {
  isActive: true,
  subcategories: [{ id: 'security-cameras', name: 'Security Cameras', isActive: true }],
  specificationTemplate: [{ name: 'Product Type', required: true }],
};
const brand = { isActive: true, name: 'Generic' };

const baseSubmission = () => sanitizeSupplierProductDraft({
  name: 'A9 Security Camera',
  supplierSku: 'A9-001',
  brand: 'generic',
  category: 'electronics',
  subcategory: 'security-cameras',
  productType: 'Wireless Security Camera',
  price: 4200,
  stock: 8,
  imageUrl: 'https://cdn.example.com/a9.jpg',
  description: 'Compact wireless security camera with night vision.',
  specs: { 'Product Type': 'Wireless Security Camera' },
});

test('A new supplier product accepts a valid description and rejects missing, empty, and whitespace-only values', () => {
  const valid = baseSubmission();
  assert.deepEqual(validateSupplierProductForSubmission(valid, category, brand), []);

  for (const description of [undefined, '', '   ', '\n\t']) {
    const draft = sanitizeSupplierProductDraft({ ...valid, description });
    const errors = validateSupplierProductForSubmission(draft, category, brand);
    assert.ok(errors.includes(SUPPLIER_FULL_DESCRIPTION_REQUIRED_MESSAGE), String(description));
  }
});

test('B product change submissions use the same full description validation', () => {
  const valid = baseSubmission();
  const changed = sanitizeSupplierProductDraft({
    ...valid,
    description: 'Updated full description for an existing supplier product.',
  });
  assert.deepEqual(validateSupplierProductForSubmission(changed, category, brand), []);

  const blankChange = sanitizeSupplierProductDraft({ ...valid, description: '   ' });
  assert.ok(validateSupplierProductForSubmission(blankChange, category, brand).includes(SUPPLIER_FULL_DESCRIPTION_REQUIRED_MESSAGE));
});

test('C approval cannot publish when the effective full description is blank', () => {
  assert.throws(
    () => resolveSupplierFullDescription('', '   ', 20_000),
    (error: unknown) => error instanceof ApiError
      && error.statusCode === 422
      && error.message === SUPPLIER_FULL_DESCRIPTION_REQUIRED_MESSAGE,
  );

  assert.throws(
    () => parseSupplierApprovalDraft({
      productName: 'Supplier Phone',
      category: 'phones',
      brand: 'brand-1',
      sellingPrice: 110_000,
      comparePrice: 120_000,
      stock: 5,
      isActive: true,
      primaryImageUrl: 'https://supplier.example/phone.jpg',
      galleryImageUrls: [],
      description: '   ',
    }),
    /Full description is required/,
  );

  const reviewDraft = createSupplierReviewDraft({
    id: 'queue-1',
    productName: 'Supplier Phone',
    supplierCode: 'A2Z-PHONE-1',
    costPrice: 80_000,
    marketPrice: 120_000,
    stock: 5,
    productPayload: {
      id: 'supplier-phone',
      name: 'Supplier Phone',
      description: 'Existing supplier description',
      price: 110_000,
      imageUrl: 'https://supplier.example/phone.jpg',
      category: 'phones',
      brand: 'brand-1',
      stock: 5,
      rating: 0,
      reviewsCount: 0,
      specs: {},
    },
  });
  const errors = validateSupplierReviewDraft({ ...reviewDraft, description: '   ' });
  assert.equal(errors.description, 'Full description is required.');
});

test('D stock-only proposals remain unaffected by full description validation', () => {
  const route = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  const stockProposal = route.slice(route.indexOf('stock-proposal'), route.indexOf('stock-proposal') + 1200);
  assert.doesNotMatch(stockProposal, /validateSupplierProductForSubmission/);
  assert.match(stockProposal, /proposedStock/);
});

test('E existing maximum-length limits still apply', () => {
  const maxPortalDescription = 'x'.repeat(SUPPLIER_PORTAL_FULL_DESCRIPTION_MAX_LENGTH + 50);
  const draft = sanitizeSupplierProductDraft({
    ...baseSubmission(),
    description: maxPortalDescription,
  });
  assert.equal(draft.description.length, SUPPLIER_PORTAL_FULL_DESCRIPTION_MAX_LENGTH);
  assert.deepEqual(validateSupplierProductForSubmission(draft, category, brand), []);

  assert.throws(
    () => resolveSupplierFullDescription('y'.repeat(20_001), 'fallback description', 20_000),
    /20,000 characters or fewer/,
  );
});

test('approval resolves the effective description from draft or original payload', () => {
  assert.equal(
    resolveSupplierFullDescription(undefined, 'Legacy supplier description', 20_000),
    'Legacy supplier description',
  );
  assert.equal(
    resolveSupplierFullDescription('Admin-edited description', 'Legacy supplier description', 20_000),
    'Admin-edited description',
  );
});
