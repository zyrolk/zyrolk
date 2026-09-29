import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import { doc, getFirestore, terminate, writeBatch } from 'firebase/firestore';
import type { Product } from '../src/types';
import { toFirestoreWishlistProduct, toFirestoreWishlistSnapshot } from '../src/services/storefront/wishlistCloudSnapshot';
import { filterCommerceProducts } from '../src/services/storefront/previewCommerceGuard';
import { projectStorefrontProduct } from '../src/services/storefront/storefrontCatalog';

const appSource = readFileSync('src/App.tsx', 'utf8');

const wishlistSyncStart = appSource.indexOf('const syncWishlistToFirestore = async () => {');
const wishlistSyncSource = appSource.slice(wishlistSyncStart, appSource.indexOf('syncWishlistToFirestore();', wishlistSyncStart));

const fullProduct: Product = {
  id: 'zyro-full-product',
  name: 'Full Product',
  description: 'Complete description',
  price: 4500,
  originalPrice: 5000,
  promotionEnabled: true,
  discount: 10,
  imageUrl: 'https://example.invalid/full.webp',
  imageUrls: ['https://example.invalid/full-2.webp'],
  category: 'phone-accessories',
  subcategory: 'car-holders',
  brand: 'zyro-brand',
  model: 'ZX-1',
  barcode: '4790000000001',
  productType: 'holder',
  tags: ['car'],
  shortDescription: 'Short',
  keyFeatures: ['Sturdy'],
  whatsIncluded: ['Holder'],
  rating: 4.5,
  reviewsCount: 12,
  isNew: true,
  isFeatured: false,
  isBestSeller: false,
  isActive: true,
  stock: 20,
  specs: { Colour: 'Black' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-28T18:26:32.000Z',
};

// Field presence of live product ZY-93F9C51591A3 (zyro-7b4071085ff3149bbd0068682d8ee9ba): originalPrice,
// discount and brand absent; model, barcode, productType and shortDescription stored as empty strings.
const liveProductData: Record<string, unknown> = {
  name: 'Multifunctional Car Number Plate Mobile Phone Holder',
  description: 'Car number plate phone holder',
  price: 999,
  imageUrl: 'https://example.invalid/holder.webp',
  imageUrls: [],
  category: 'phone-accessories',
  subcategory: 'car-holders',
  model: '',
  barcode: '',
  productType: '',
  shortDescription: '',
  isActive: true,
  stock: 217,
  specs: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: { toDate: () => new Date('2026-09-28T18:26:32.000Z') },
};
const LIVE_UNDEFINED_KEYS = ['originalPrice', 'discount', 'brand', 'model', 'barcode', 'productType', 'shortDescription'];

// A document carrying only the required fields leaves every optional projection key undefined.
const MINIMAL_UNDEFINED_KEYS = [
  'originalPrice', 'discount', 'subcategory', 'brand', 'model', 'barcode', 'productType', 'shortDescription', 'createdAt', 'updatedAt',
];

const liveProduct = (): Product => projectStorefrontProduct('zyro-7b4071085ff3149bbd0068682d8ee9ba', liveProductData);
const minimalProduct = (): Product => projectStorefrontProduct('zyro-minimal-product', { name: 'Minimal', price: 100, isActive: true });

const undefinedKeysOf = (product: Product): string[] => Object.entries(product)
  .filter(([, value]) => value === undefined)
  .map(([key]) => key)
  .sort();

const withFirestoreParser = (run: (parse: (data: Record<string, unknown>) => void) => void) => async () => {
  const app = initializeApp({ projectId: 'demo-wishlist-cloud-snapshot', apiKey: 'demo', appId: 'demo' }, `wishlist-snapshot-${Math.random()}`);
  const firestore = getFirestore(app);
  try {
    // An uncommitted batch runs the SDK's user-data parser synchronously without any network request.
    run((data) => { writeBatch(firestore).update(doc(firestore, 'users', 'test-uid'), data); });
  } finally {
    await terminate(firestore);
    await deleteApp(app);
  }
};

test('live and minimal projected shapes are rejected raw and accepted after sanitizing', withFirestoreParser((parse) => {
  const wishlist = filterCommerceProducts([liveProduct(), minimalProduct()]);
  assert.deepEqual(undefinedKeysOf(wishlist[0]), [...LIVE_UNDEFINED_KEYS].sort());
  assert.deepEqual(undefinedKeysOf(wishlist[1]), [...MINIMAL_UNDEFINED_KEYS].sort());

  assert.throws(
    () => parse({ wishlist }),
    (error: { code?: string; message?: string }) => error.code === 'invalid-argument'
      && /Unsupported field value: undefined/u.test(error.message ?? ''),
  );

  const snapshot = toFirestoreWishlistSnapshot(wishlist);
  assert.doesNotThrow(() => parse({ wishlist: snapshot }));
  assert.doesNotThrow(() => parse({ wishlist: toFirestoreWishlistSnapshot([fullProduct]) }));
}));

test('every top-level undefined key is omitted and no undefined value remains', () => {
  const [live, minimal] = toFirestoreWishlistSnapshot([liveProduct(), minimalProduct()]);
  for (const key of LIVE_UNDEFINED_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(live, key), false, key);
  }
  for (const key of MINIMAL_UNDEFINED_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(minimal, key), false, key);
  }
  assert.equal(Object.values(live).includes(undefined), false);
  assert.equal(Object.values(minimal).includes(undefined), false);
  assert.equal(live.id, 'zyro-7b4071085ff3149bbd0068682d8ee9ba');
  assert.equal(live.price, 999);
  assert.equal(live.stock, 217);
});

test('false, 0, empty string, null, [] and {} are preserved', () => {
  const product = {
    ...fullProduct,
    isFeatured: false,
    stock: 0,
    rating: 0,
    model: '',
    barcode: null,
    tags: [],
    specs: {},
  } as unknown as Product;
  const persisted = toFirestoreWishlistProduct(product) as unknown as Record<string, unknown>;
  assert.equal(persisted.isFeatured, false);
  assert.equal(persisted.stock, 0);
  assert.equal(persisted.rating, 0);
  assert.equal(persisted.model, '');
  assert.equal(persisted.barcode, null);
  assert.deepEqual(persisted.tags, []);
  assert.deepEqual(persisted.specs, {});
  for (const key of ['isFeatured', 'stock', 'rating', 'model', 'barcode', 'tags', 'specs']) {
    assert.equal(Object.prototype.hasOwnProperty.call(persisted, key), true, key);
  }
});

test('fully populated product persists semantically identical as a new object', () => {
  const wishlist = [fullProduct];
  const snapshot = toFirestoreWishlistSnapshot(wishlist);
  assert.deepEqual(snapshot, wishlist);
  assert.notEqual(snapshot, wishlist);
  assert.notEqual(snapshot[0], fullProduct);
  assert.equal(snapshot[0].specs, fullProduct.specs);
});

test('sanitizer does not mutate the source products or wishlist array', () => {
  const live = liveProduct();
  const wishlist = [live, fullProduct];
  const liveKeysBefore = Object.keys(live);
  const fullBefore = { ...fullProduct };
  const snapshot = toFirestoreWishlistSnapshot(wishlist);
  assert.deepEqual(Object.keys(live), liveKeysBefore);
  for (const key of LIVE_UNDEFINED_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(live, key), true, key);
    assert.equal(live[key as keyof Product], undefined, key);
  }
  assert.deepEqual(fullProduct, fullBefore);
  assert.equal(wishlist.length, 2);
  assert.equal(wishlist[0], live);
  assert.equal(wishlist[1], fullProduct);
  assert.notEqual(snapshot, wishlist);
});

test('existing-user updateDoc and new-user setDoc both write the sanitized wishlist', () => {
  assert.notEqual(wishlistSyncStart, -1);
  assert.match(appSource, /import \{ toFirestoreWishlistSnapshot \} from '\.\/services\/storefront\/wishlistCloudSnapshot';/u);
  assert.match(wishlistSyncSource, /const firestoreWishlist = toFirestoreWishlistSnapshot\(commerceWishlist\);/u);
  assert.match(wishlistSyncSource, /await updateDoc\(userRef, \{ wishlist: firestoreWishlist \}\);/u);
  assert.match(wishlistSyncSource, /await setDoc\(userRef, \{[\s\S]*wishlist: firestoreWishlist\s*\}\);/u);
  assert.doesNotMatch(wishlistSyncSource, /wishlist: commerceWishlist/u);
  assert.equal((appSource.match(/toFirestoreWishlistSnapshot\(/gu) ?? []).length, 1);
});

test('browser-storage wishlist persistence and hydration still use the unsanitized commerce wishlist', () => {
  assert.match(appSource, /const commerceWishlist = filterCommerceProducts\(wishlist\);\s*writeStoredJson\(getBrowserStorage\('localStorage'\), 'zyro_wishlist', commerceWishlist\);/u);
  assert.match(appSource, /readStoredArray<Product>\(getBrowserStorage\('localStorage'\), 'zyro_wishlist'\)/u);
});

test('login cloud-wishlist merge is unchanged and accepts stored products without the omitted keys', () => {
  assert.match(appSource, /const cloudWishlist = filterCommerceProducts\(userData\.wishlist as Product\[\]\);/u);
  assert.match(appSource, /if \(!merged\.some\(cloudItem => cloudItem\.id === localItem\.id\)\) \{\s*merged\.push\(localItem\);/u);

  const stored = toFirestoreWishlistSnapshot([liveProduct()]);
  const cloudWishlist = filterCommerceProducts(stored);
  assert.equal(cloudWishlist.length, 1);
  assert.equal(cloudWishlist[0].id, 'zyro-7b4071085ff3149bbd0068682d8ee9ba');
  assert.equal(cloudWishlist[0].price, 999);
  assert.equal(cloudWishlist[0].originalPrice, undefined);
  assert.equal(cloudWishlist[0].brand, undefined);
});

test('cart sync still uses its own snapshot helper exactly once', () => {
  assert.match(appSource, /const firestoreCart = toFirestoreCartSnapshot\(commerceCart\);/u);
  assert.equal((appSource.match(/toFirestoreCartSnapshot\(/gu) ?? []).length, 1);
  assert.doesNotMatch(appSource, /toFirestoreWishlistSnapshot\(commerceCart\)/u);
});
