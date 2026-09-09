import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_PRODUCT_ID_PREFIX,
  canUseProductInCommerce,
  filterCommerceCartItems,
  isPreviewProductId,
} from '../src/services/storefront/previewCommerceGuard';

const appSource = readFileSync('src/App.tsx', 'utf8');
const checkoutSource = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
const homepageSource = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');

const liveProduct = { id: 'live-product-1' };
const previewProduct = { id: `${PREVIEW_PRODUCT_ID_PREFIX}reference-phone` };

test('preview product IDs are explicitly outside the commerce boundary', () => {
  assert.equal(isPreviewProductId(previewProduct.id), true);
  assert.equal(canUseProductInCommerce(previewProduct), false);
  assert.equal(canUseProductInCommerce(liveProduct), true);
});

test('preview cart items are removed before local or Firestore cart persistence', () => {
  const filtered = filterCommerceCartItems([
    { product: previewProduct, quantity: 1 },
    { product: liveProduct, quantity: 2 },
  ] as never);

  assert.deepEqual(filtered.map(item => item.product.id), [liveProduct.id]);
  assert.doesNotMatch(JSON.stringify(filtered), /preview:/u);
  assert.match(appSource, /filterCommerceCartItems\(cart\)/u);
  assert.match(appSource, /const commerceWishlist = filterCommerceProducts\(wishlist\)/u);
  assert.match(appSource, /const commerceRecentlyViewedIds = filterCommerceProductIds\(recentlyViewedProductIds\)/u);
  assert.match(appSource, /updateDoc\(userRef, \{ cart: commerceCart \}\)/u);
  assert.match(appSource, /updateDoc\(userRef, \{ wishlist: commerceWishlist \}\)/u);
  assert.match(appSource, /updateDoc\(userRef, \{ recentlyViewedProductIds: commerceRecentlyViewedIds \}\)/u);
  assert.match(appSource, /cart: commerceCart/u);
});

test('preview items cannot reach cart entry or checkout payloads', () => {
  assert.match(appSource, /if \(!canUseProductInCommerce\(product\) \|\| product\.stock <= 0\) return;/u);
  assert.match(appSource, /if \(!canUseProductInCommerce\(product\)\) return;/u);
  assert.match(appSource, /const commerceProductIds = filterCommerceProductIds\(productIds\)/u);
  assert.match(appSource, /const storefrontProducts = useMemo\(\(\) => filterCommerceProducts\(products\)/u);
  assert.match(checkoutSource, /const commerceCartItems = useMemo\(\(\) => filterCommerceCartItems\(cartItems\)/u);
  assert.match(checkoutSource, /cartItems: commerceCartItems\.map/u);
  assert.doesNotMatch(checkoutSource, /cartItems: cartItems\.map/u);
});

test('the live homepage does not render preview-only product cards', () => {
  assert.match(homepageSource, /if \(!import\.meta\.env\.DEV\) return;/u);
  assert.match(homepageSource, /void import\('\.\.\/services\/storefront\/homepagePreviewPresentation'\)/u);
  assert.match(homepageSource, /if \(loading \|\| hasLiveProducts\)/u);
  assert.match(homepageSource, /if \(!shouldShowPreviewShelf \|\| !previewPresentation\) return null/u);
  assert.match(homepageSource, /<HomepagePreviewProductShelf/u);
  assert.doesNotMatch(homepageSource, /reference-phone/u);
  assert.match(homepageSource, /products: Product\[\]/u);
  assert.match(homepageSource, /onAddToCart=\{onAddToCart\}/u);
});
