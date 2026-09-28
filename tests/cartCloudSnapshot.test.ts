import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import { doc, getFirestore, terminate, writeBatch } from 'firebase/firestore';
import type { CartItem, Product } from '../src/types';
import { toFirestoreCartItem, toFirestoreCartSnapshot } from '../src/services/storefront/cartCloudSnapshot';
import { filterCommerceCartItems } from '../src/services/storefront/previewCommerceGuard';
import { projectStorefrontProduct } from '../src/services/storefront/storefrontCatalog';

const appSource = readFileSync('src/App.tsx', 'utf8');
const checkoutSource = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');

const cartSyncStart = appSource.indexOf('const syncCartToFirestore = async () => {');
const cartSyncSource = appSource.slice(cartSyncStart, appSource.indexOf('syncCartToFirestore();', cartSyncStart));

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
const liveFailingProductData: Record<string, unknown> = {
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

const liveFailingItem = (): CartItem => ({
  product: projectStorefrontProduct('zyro-7b4071085ff3149bbd0068682d8ee9ba', liveFailingProductData),
  quantity: 1,
});

const withFirestoreParser = (run: (parse: (data: Record<string, unknown>) => void) => void) => async () => {
  const app = initializeApp({ projectId: 'demo-cart-cloud-snapshot', apiKey: 'demo', appId: 'demo' }, `cart-snapshot-${Math.random()}`);
  const firestore = getFirestore(app);
  try {
    // An uncommitted batch runs the SDK's user-data parser synchronously without any network request.
    run((data) => { writeBatch(firestore).update(doc(firestore, 'users', 'test-uid'), data); });
  } finally {
    await terminate(firestore);
    await deleteApp(app);
  }
};

test('fully populated cart item is persisted semantically identical', () => {
  const item: CartItem = { product: fullProduct, quantity: 3 };
  const persisted = toFirestoreCartItem(item);
  assert.deepEqual(persisted, item);
  assert.notEqual(persisted, item);
  assert.notEqual(persisted.product, item.product);
});

test('explicit undefined product keys are omitted from the Firestore-bound snapshot', () => {
  const item: CartItem = {
    product: { ...fullProduct, originalPrice: undefined, discount: undefined, brand: undefined, subcategory: undefined, createdAt: undefined },
    quantity: 2,
  };
  const persisted = toFirestoreCartItem(item);
  for (const key of ['originalPrice', 'discount', 'brand', 'subcategory', 'createdAt']) {
    assert.equal(Object.prototype.hasOwnProperty.call(persisted.product, key), false, key);
  }
  assert.equal(Object.values(persisted.product).includes(undefined), false);
});

test('required fields and quantity remain identical', () => {
  const item = liveFailingItem();
  const persisted = toFirestoreCartItem({ ...item, quantity: 4 });
  for (const key of ['id', 'name', 'price', 'imageUrl', 'stock', 'category'] as const) {
    assert.equal(persisted.product[key], item.product[key], key);
  }
  assert.equal(persisted.product.price, 999);
  assert.equal(persisted.quantity, 4);
});

test('defined optional fields are preserved', () => {
  const persisted = toFirestoreCartItem({ product: fullProduct, quantity: 1 });
  assert.equal(persisted.product.originalPrice, 5000);
  assert.equal(persisted.product.discount, 10);
  assert.equal(persisted.product.brand, 'zyro-brand');
  assert.equal(persisted.product.model, 'ZX-1');
  assert.equal(persisted.product.subcategory, 'car-holders');
  assert.equal(persisted.product.promotionEnabled, true);
});

test('falsy-but-valid values are not stripped', () => {
  const product = {
    ...fullProduct,
    isFeatured: false,
    stock: 0,
    rating: 0,
    model: '',
    tags: [],
    specs: {},
    barcode: null,
  } as unknown as Product;
  const persisted = toFirestoreCartItem({ product, quantity: 0 });
  assert.equal(persisted.product.isFeatured, false);
  assert.equal(persisted.product.stock, 0);
  assert.equal(persisted.product.rating, 0);
  assert.equal(persisted.product.model, '');
  assert.deepEqual(persisted.product.tags, []);
  assert.deepEqual(persisted.product.specs, {});
  assert.equal((persisted.product as unknown as { barcode: unknown }).barcode, null);
  assert.equal(persisted.quantity, 0);
});

test('sanitizer does not mutate the source product, cart item or cart array', () => {
  const item = liveFailingItem();
  const cart = [item];
  const productKeysBefore = Object.keys(item.product);
  const snapshot = toFirestoreCartSnapshot(cart);
  assert.deepEqual(Object.keys(item.product), productKeysBefore);
  for (const key of LIVE_UNDEFINED_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(item.product, key), true, key);
  }
  assert.equal(cart.length, 1);
  assert.equal(cart[0], item);
  assert.notEqual(snapshot, cart);
  assert.notEqual(snapshot[0], item);
});

test('live failing shape for ZY-93F9C51591A3 is rejected raw and accepted after sanitizing', withFirestoreParser((parse) => {
  const item = liveFailingItem();
  const undefinedKeys = Object.entries(item.product).filter(([, value]) => value === undefined).map(([key]) => key);
  assert.deepEqual(undefinedKeys.sort(), [...LIVE_UNDEFINED_KEYS].sort());

  assert.throws(
    () => parse({ cart: [item] }),
    (error: { code?: string; message?: string }) => error.code === 'invalid-argument'
      && /Unsupported field value: undefined/u.test(error.message ?? ''),
  );

  const snapshot = toFirestoreCartSnapshot([item]);
  for (const key of LIVE_UNDEFINED_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot[0].product, key), false, key);
  }
  assert.doesNotThrow(() => parse({ cart: snapshot }));
  assert.doesNotThrow(() => parse({ cart: toFirestoreCartSnapshot([{ product: fullProduct, quantity: 2 }]) }));
}));

test('existing-user updateDoc and new-user setDoc both write the sanitized cart', () => {
  assert.notEqual(cartSyncStart, -1);
  assert.match(appSource, /import \{ toFirestoreCartSnapshot \} from '\.\/services\/storefront\/cartCloudSnapshot';/u);
  assert.match(cartSyncSource, /const firestoreCart = toFirestoreCartSnapshot\(commerceCart\);/u);
  assert.match(cartSyncSource, /await updateDoc\(userRef, \{ cart: firestoreCart \}\);/u);
  assert.match(cartSyncSource, /await setDoc\(userRef, \{[\s\S]*cart: firestoreCart\s*\}\);/u);
  assert.doesNotMatch(cartSyncSource, /cart: commerceCart/u);
  assert.equal((appSource.match(/toFirestoreCartSnapshot\(/gu) ?? []).length, 1);
});

test('browser-storage cart persistence still uses the unsanitized commerce cart', () => {
  assert.match(appSource, /const commerceCart = filterCommerceCartItems\(cart\);\s*writeStoredJson\(getBrowserStorage\('localStorage'\), 'zyro_cart', commerceCart\);/u);
  assert.match(appSource, /readStoredArray<CartItem>\(getBrowserStorage\('localStorage'\), 'zyro_cart'\)/u);
  assert.match(appSource, /await updateDoc\(userRef, \{ wishlist: commerceWishlist \}\);/u);
});

test('checkout request shape from the in-memory cart is unchanged', () => {
  assert.doesNotMatch(checkoutSource, /toFirestoreCart/u);
  assert.match(checkoutSource, /cartItems: commerceCartItems\.map\(item => \(\{\s*productId: item\.product\.id,\s*quantity: item\.quantity,\s*expectedUnitPrice: item\.product\.price,\s*\}\)\)/u);
});

test('login cloud-cart merge still accepts stored products without the omitted optional keys', () => {
  assert.match(appSource, /const cloudCart = filterCommerceCartItems\(userData\.cart as CartItem\[\]\);/u);
  assert.match(appSource, /const existing = merged\.find\(cloudItem => cloudItem\.product\.id === localItem\.product\.id\);/u);
  assert.match(appSource, /existing\.quantity = Math\.max\(existing\.quantity, localItem\.quantity\);/u);

  const stored = toFirestoreCartSnapshot([liveFailingItem()]);
  const cloudCart = filterCommerceCartItems(stored);
  assert.equal(cloudCart.length, 1);
  assert.equal(cloudCart[0].product.id, 'zyro-7b4071085ff3149bbd0068682d8ee9ba');
  assert.equal(cloudCart[0].product.price, 999);
  assert.equal(cloudCart[0].product.originalPrice, undefined);
  assert.equal(cloudCart[0].product.brand, undefined);
});
