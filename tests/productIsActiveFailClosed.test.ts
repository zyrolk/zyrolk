import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { isProductExplicitlyActive } from '../src/services/storefront/productAvailability';
import { projectStorefrontProduct } from '../src/services/storefront/storefrontCatalog';
import { isProductExplicitlyActive as isProductExplicitlyActiveServer } from '../functions/src/api/products/productAvailability';
import { parseSupplierApprovalDraft } from '../functions/src/api/suppliers/supplierApproval';
import { createSupplierReviewDraft } from '../src/services/supplierReviewEditor';

const read = (path: string): string => readFileSync(path, 'utf8');
const baseProductFields = {
  name: 'Availability probe',
  description: 'Test product',
  price: 1500,
  imageUrl: 'https://cdn.example/product.webp',
  category: 'home',
  stock: 3,
};

test('isProductExplicitlyActive treats only boolean true as active', () => {
  for (const candidate of [true, false, null, undefined, 0, 1, 'true', 'false', {}]) {
    const expected = candidate === true;
    assert.equal(isProductExplicitlyActive(candidate), expected);
    assert.equal(isProductExplicitlyActiveServer(candidate), expected);
  }
});

test('A catalogue projection: explicit true visible, false and missing hidden', () => {
  const active = projectStorefrontProduct('active', { ...baseProductFields, isActive: true });
  const inactive = projectStorefrontProduct('inactive', { ...baseProductFields, isActive: false });
  const missing = projectStorefrontProduct('missing', { ...baseProductFields });
  const malformed = projectStorefrontProduct('malformed', { ...baseProductFields, isActive: 'yes' });

  assert.equal(active.isActive, true);
  assert.equal(inactive.isActive, false);
  assert.equal(missing.isActive, false);
  assert.equal(malformed.isActive, false);
});

test('B direct product load: only explicit true is treated as loadable in storefront paths', () => {
  const app = read('src/App.tsx');
  const catalog = read('src/services/storefront/storefrontCatalog.ts');

  assert.match(catalog, /isProductExplicitlyActive\(data\.isActive\)/);
  assert.match(app, /isProductExplicitlyActive\(candidate\.isActive\)/);
  assert.match(app, /setCurrentPage\('not-found'\)/);

  const loadable = projectStorefrontProduct('p1', { ...baseProductFields, isActive: true });
  const unavailable = projectStorefrontProduct('p2', { ...baseProductFields, isActive: false });
  const legacy = projectStorefrontProduct('p3', { ...baseProductFields });

  assert.ok(isProductExplicitlyActive(loadable.isActive));
  assert.ok(!isProductExplicitlyActive(unavailable.isActive));
  assert.ok(!isProductExplicitlyActive(legacy.isActive));
});

test('C checkout rejects non-explicit active products before stock or order writes', () => {
  const checkout = read('functions/src/api/routes/checkout.ts');
  const serverCheckout = read('server.ts');

  for (const source of [checkout, serverCheckout]) {
    assert.match(source, /isProductExplicitlyActive/);
    assert.match(source, /A cart item is no longer available/);
    assert.match(source, /is not available for purchase/);
    const pushIndex = source.indexOf('productUpdates.push');
    const inactiveGuard = Math.max(
      source.indexOf('isProductExplicitlyActive(pData.isActive)'),
      source.indexOf('!isProductExplicitlyActive(pData.isActive)'),
    );
    assert.ok(inactiveGuard >= 0);
    assert.ok(pushIndex > inactiveGuard, 'inactive guard must precede stock decrement writes');
  }
});

test('D sitemap includes only products with explicit isActive === true', () => {
  assert.match(read('functions/src/api/app.ts'), /product\.data\(\)\.isActive === true/);
  assert.match(read('server.ts'), /product\.data\(\)\.isActive === true/);
  assert.doesNotMatch(read('functions/src/api/app.ts'), /product\.data\(\)\.isActive !== false/);
  assert.doesNotMatch(read('server.ts'), /product\.data\(\)\.isActive !== false/);
});

test('E Firestore rules require explicit product isActive for public reads', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /function isPublicProductData\(data\)/);
  assert.match(rules, /data\.isActive == true/);
  assert.match(rules, /allow read: if isPublicProductData\(resource\.data\)/);
  assert.match(rules, /match \/product_private\/\{productId\}[\s\S]*allow read: if isAdmin\(\)/);
  assert.match(rules, /match \/products\/\{productId\}[\s\S]*allow create, update, delete: if false/);
});

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const [rulesHost, rulesPortValue] = (firestoreHost || '').split(':');
const rulesPort = Number(rulesPortValue);
const canRunRulesEmulator = Boolean(rulesHost && Number.isInteger(rulesPort) && rulesPort > 0);

test('E Firestore rules emulator: public reads fail closed unless isActive is explicitly true', {
  skip: canRunRulesEmulator ? undefined : 'Set FIRESTORE_EMULATOR_HOST and start the Firestore Emulator to run rules integration coverage.',
}, async () => {
  const environment = await initializeTestEnvironment({
    projectId: 'zyro-product-isactive-fail-closed',
    firestore: { host: rulesHost, port: rulesPort, rules: read('firestore.rules') },
  });
  try {
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'products', 'active-product'), { name: 'Active', price: 100, isActive: true });
      await setDoc(doc(db, 'products', 'inactive-product'), { name: 'Inactive', price: 100, isActive: false });
      await setDoc(doc(db, 'products', 'legacy-product'), { name: 'Legacy', price: 100 });
      await setDoc(doc(db, 'product_private', 'active-product'), { sku: 'ZY-ACTIVE' });
    });

    const anonymousDb = environment.unauthenticatedContext().firestore();
    const customerDb = environment.authenticatedContext('customer-user').firestore();
    const adminDb = environment.authenticatedContext('admin-user', { admin: true }).firestore();

    await assertSucceeds(getDoc(doc(anonymousDb, 'products', 'active-product')));
    await assertSucceeds(getDoc(doc(customerDb, 'products', 'active-product')));
    await assertFails(getDoc(doc(anonymousDb, 'products', 'inactive-product')));
    await assertFails(getDoc(doc(customerDb, 'products', 'inactive-product')));
    await assertFails(getDoc(doc(anonymousDb, 'products', 'legacy-product')));
    await assertFails(getDoc(doc(customerDb, 'products', 'legacy-product')));
    await assertFails(getDoc(doc(customerDb, 'product_private', 'active-product')));
    await assertSucceeds(getDoc(doc(adminDb, 'product_private', 'active-product')));
  } finally {
    await environment.cleanup();
  }
});

test('F supplier publication requires explicit isActive true in approval payload resolution', () => {
  const supplierApproval = read('functions/src/api/suppliers/supplierApproval.ts');
  assert.match(supplierApproval, /\(draft\?\.isActive \?\? originalPayload\.isActive\) === true/);
  assert.match(supplierApproval, /if \(typeof draft\.isActive !== "boolean"\)/);

  const draft = parseSupplierApprovalDraft({
    ...createSupplierReviewDraft({
      id: 'queue-1',
      productName: 'Supplier Phone',
      supplierCode: 'A2Z-PHONE-1',
      costPrice: 80_000,
      marketPrice: 120_000,
      stock: 5,
      productPayload: {
        id: 'supplier-phone',
        name: 'Supplier Phone',
        description: 'Supplier description',
        price: 110_000,
        imageUrl: 'https://supplier.example/phone.jpg',
        category: 'phones',
        brand: 'brand-1',
        stock: 5,
        rating: 0,
        reviewsCount: 0,
        specs: {},
        isActive: true,
      },
    }),
    primaryImageUrl: 'https://supplier.example/phone.jpg',
    galleryImageUrls: [],
  });
  assert.ok(draft);
  assert.equal(draft.isActive, true);
});
