import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { adminDb } from '../functions/src/api/firebase';
import {
  parseAdminProductDraft,
  updateAdminProduct,
} from '../functions/src/api/products/adminProductManagement';

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const primaryImage = 'https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/primary.webp?alt=media';
const longManagedImage = `https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/${'supplier-media%2F'.repeat(12)}managed.webp?alt=media`;

const draft = (overrides: Record<string, unknown> = {}) => ({
  id: 'gallery-product',
  sku: 'ZY-GALLERY01',
  name: 'Gallery Product',
  description: 'A product with managed supplier media.',
  shortDescription: '',
  price: 1_146,
  imageUrl: primaryImage,
  imageUrls: [],
  category: 'electronics',
  subcategory: '',
  brand: 'brand-1',
  model: '',
  barcode: '',
  productType: '',
  tags: [],
  keyFeatures: [],
  whatsIncluded: [],
  stock: 5,
  specs: {},
  isNew: false,
  isFeatured: false,
  isBestSeller: false,
  isActive: false,
  supplierId: 'dropex',
  supplierItemCode: 'DROP-GALLERY01',
  ...overrides,
});

test('valid managed Firebase Storage gallery URLs above 240 characters are accepted', () => {
  assert.ok(longManagedImage.length > 240);
  assert.ok(longManagedImage.length < 2_048);
  const parsed = parseAdminProductDraft(draft({ imageUrls: [longManagedImage] }));
  assert.deepEqual(parsed.imageUrls, [new URL(longManagedImage).toString()]);
});

test('Admin Product Editor gallery keeps the maximum at 20 entries', () => {
  const imageUrls = Array.from({ length: 20 }, (_, index) => `https://cdn.example.test/gallery-${index}.webp`);
  assert.equal(parseAdminProductDraft(draft({ imageUrls })).imageUrls.length, 20);
  assert.throws(
    () => parseAdminProductDraft(draft({ imageUrls: [...imageUrls, 'https://cdn.example.test/gallery-20.webp'] })),
    /Product gallery is invalid/u,
  );
});

test('gallery URLs above 2048 characters and unsupported protocols remain rejected', () => {
  assert.throws(
    () => parseAdminProductDraft(draft({ imageUrls: [`https://cdn.example.test/${'a'.repeat(2_050)}`] })),
    /Gallery image is too long/u,
  );
  assert.throws(
    () => parseAdminProductDraft(draft({ imageUrls: ['javascript:alert(1)'] })),
    /Gallery image must use a valid http or https URL/u,
  );
});

test('Admin Product Management does not acquire or delete supplier media', () => {
  const implementation = readFileSync('functions/src/api/products/adminProductManagement.ts', 'utf8');
  assert.doesNotMatch(implementation, /getStorage|supplier_media_assets/u);
});

test('supplier-backed admin update preserves four managed gallery URLs and routing', {
  skip: canRun ? undefined : 'Firestore Emulator is required.',
  timeout: 180_000,
}, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const productId = `gallery-product-${suffix}`;
  const categoryId = `gallery-category-${suffix}`;
  const brandId = `gallery-brand-${suffix}`;
  const supplierItemCode = `DROP-GALLERY-${suffix}`;
  const imageUrls = [
    longManagedImage,
    `https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/secondary-1-${suffix}.webp?alt=media`,
    `https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/secondary-2-${suffix}.webp?alt=media`,
    `https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/secondary-3-${suffix}.webp?alt=media`,
  ];
  const managedMedia = [{
    assetId: `asset-${suffix}`,
    productId,
    firebaseStorageUrl: imageUrls[0],
  }];
  const privateProduct = {
    productId,
    sku: `ZY-${suffix.toUpperCase()}`,
    fulfilmentMode: 'supplier',
    supplierId: 'dropex',
    supplierItemCode,
    supplierMedia: managedMedia,
    supplierOfferSelection: { activeOfferId: `offer-${suffix}` },
  };
  const publicProduct = draft({
    id: productId,
    sku: privateProduct.sku,
    category: categoryId,
    brand: brandId,
    imageUrl: imageUrls[0],
    imageUrls,
  });

  await Promise.all([
    adminDb.collection('categories').doc(categoryId).set({ name: 'Electronics', isActive: true }),
    adminDb.collection('brands').doc(brandId).set({ name: 'Test Brand', isActive: true }),
    adminDb.collection('products').doc(productId).set(publicProduct),
    adminDb.collection('product_private').doc(productId).set(privateProduct),
    adminDb.collection('supplier_media_assets').doc(managedMedia[0].assetId).set(managedMedia[0]),
  ]);

  const result = await updateAdminProduct(
    adminDb,
    productId,
    { uid: `gallery-admin-${suffix}`, email: 'admin@example.test' },
    draft({
      id: productId,
      sku: privateProduct.sku,
      category: categoryId,
      brand: brandId,
      supplierId: 'dropex',
      supplierItemCode,
      imageUrl: imageUrls[0],
      imageUrls,
    }),
  );
  assert.equal(result.productId, productId);

  const [updatedProduct, updatedPrivate, mediaAsset] = await Promise.all([
    adminDb.collection('products').doc(productId).get(),
    adminDb.collection('product_private').doc(productId).get(),
    adminDb.collection('supplier_media_assets').doc(managedMedia[0].assetId).get(),
  ]);
  const publicData = updatedProduct.data()!;
  const privateData = updatedPrivate.data()!;
  assert.deepEqual(publicData.imageUrls, imageUrls.map((url) => new URL(url).toString()));
  assert.equal(privateData.supplierId, 'dropex');
  assert.equal(privateData.supplierItemCode, supplierItemCode);
  assert.equal(privateData.fulfilmentMode, 'supplier');
  assert.deepEqual(privateData.supplierMedia, managedMedia);
  assert.deepEqual(privateData.supplierOfferSelection, privateProduct.supplierOfferSelection);
  assert.equal(mediaAsset.exists, true);
});
