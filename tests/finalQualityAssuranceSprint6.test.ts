import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string => readFileSync(path, 'utf8');

test('customer sign-in dialog contains focus, Escape, scroll, and return-focus boundaries', () => {
  const authModal = source('src/components/AuthModal.tsx');
  assert.match(authModal, /role="dialog"/);
  assert.match(authModal, /aria-modal="true"/);
  assert.match(authModal, /event\.key === 'Escape'/);
  assert.match(authModal, /event\.key !== 'Tab'/);
  assert.match(authModal, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(authModal, /previousFocusRef\.current\?\.focus\(\)/);
  assert.match(authModal, /ref=\{closeButtonRef\}/);
});

test('mobile account sheet contains focus and motion-safe interaction boundaries', () => {
  const mobileNavigation = source('src/components/MobileBottomNav.tsx');
  assert.match(mobileNavigation, /ref=\{menuSheetRef\}/);
  assert.match(mobileNavigation, /event\.key !== 'Tab'/);
  assert.match(mobileNavigation, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(mobileNavigation, /previousFocusRef\.current\?\.focus\(\)/);
  assert.match(mobileNavigation, /prefersReducedMotion/);
});

test('Supplier Portal is mobile-wrapping, touch-safe, and its editor contains focus', () => {
  const supplierPortal = source('src/features/supplier-portal/SupplierPortal.tsx');
  assert.match(supplierPortal, /flex max-w-7xl flex-wrap gap-1/);
  assert.doesNotMatch(supplierPortal, /min-w-max gap-1/);
  assert.doesNotMatch(supplierPortal, /min-h-10/);
  assert.match(supplierPortal, /ref=\{productEditorRef\}/);
  assert.match(supplierPortal, /event\.key === 'Escape'/);
  assert.match(supplierPortal, /event\.key !== 'Tab'/);
  assert.match(supplierPortal, /productEditorPreviousFocusRef\.current\?\.focus\(\)/);
});

test('Admin mobile navigation cannot remain keyboard-focusable while off screen', () => {
  const admin = source('src/components/AdminDashboard.tsx');
  assert.match(admin, /invisible -translate-x-full md:visible md:translate-x-0/);
  assert.match(admin, /aria-controls="admin-navigation"/);
  assert.match(admin, /aria-label="Open Admin navigation"/);
  assert.match(admin, /aria-label="Close Admin navigation"/);
  assert.match(admin, /const isDarkMode = true;/);
  assert.doesNotMatch(admin, /Use light Admin theme/);
  assert.match(admin, /aria-controls="admin-notifications"/);
  assert.match(admin, /id="admin-product-modal-title"/);
  assert.match(admin, /ref=\{productModalRef\}/);
  assert.match(admin, /aria-busy=\{savingProduct\}/);
});

test('critical commerce and personalization controls meet the 44px touch target', () => {
  const checkout = source('src/features/checkout/premiumCheckout.css');
  const personalization = source('src/features/personalization/personalization.css');
  const account = source('src/features/account/accountCenter.css');
  assert.match(checkout, /article > div > span button \{[^}]*width: 2\.75rem; height: 2\.75rem/);
  assert.match(checkout, /article > aside button \{[^}]*width: 2\.75rem; height: 2\.75rem/);
  assert.match(personalization, /\.zy-wishlist-select \{[^}]*width: 2\.75rem; height: 2\.75rem/);
  assert.match(personalization, /\.zy-compare-picker > div > article > button \{[^}]*width: 2\.75rem; height: 2\.75rem/);
  assert.match(personalization, /\.zy-compare-commerce button \{[^}]*min-height: 2\.75rem/);
  assert.match(account, /\.zy-order-card footer button[^}]*min-height: 2\.75rem/);
});

test('customer surfaces retain meaningful media, loading, empty, error, and motion semantics', () => {
  const app = source('src/App.tsx');
  const productDetail = source('src/components/ProductDetailModal.tsx');
  const productCard = source('src/components/ProductCard.tsx');
  const account = source('src/features/account/AccountCenter.tsx');
  const wishlist = source('src/features/personalization/WishlistExperience.tsx');
  const styles = source('src/index.css');
  assert.match(app, /id="storefront-content"/);
  assert.match(app, /aria-busy=\{loading\}/);
  assert.match(app, /role=\{storefrontDataError \? 'alert' : 'status'\}/);
  assert.match(productDetail, /alt=\{product\.name\}/);
  assert.match(productCard, /alt=\{product\.name\}/);
  assert.match(app, /aria-label="Loading shopping collections" aria-busy="true"/);
  assert.match(account, /role="status" aria-label="Loading account information"/);
  assert.match(wishlist, /zy-personalization-empty/);
  assert.match(styles, /@media \(max-width: 389px\)/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /@media \(max-width: 1023px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
