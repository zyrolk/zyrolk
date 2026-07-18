import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ACCOUNT_PAGE_TO_SECTION,
  addRecentlyViewedProduct,
  buildRecentlyViewedProducts,
  normalizeAddressDraft,
  normalizeNotificationSettings,
  sortCustomerAddresses,
  validateAddressDraft,
} from '../src/features/account/accountData';
import { Product } from '../src/types';

const app = readFileSync('src/App.tsx', 'utf8');
const account = readFileSync('src/features/account/AccountCenter.tsx', 'utf8');
const styles = readFileSync('src/features/account/accountCenter.css', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const rules = readFileSync('firestore.rules', 'utf8');

const product = (id: string, active = true): Product => ({
  id,
  name: `Product ${id}`,
  description: '',
  price: 1000,
  imageUrl: '',
  category: 'test',
  rating: 0,
  reviewsCount: 0,
  isActive: active,
  stock: 1,
  specs: {},
});

test('account sections use the existing state-based storefront navigation', () => {
  assert.deepEqual(ACCOUNT_PAGE_TO_SECTION, {
    account: 'overview',
    'account-profile': 'profile',
    'account-addresses': 'addresses',
    'account-security': 'security',
    'account-settings': 'settings',
  });
  assert.match(app, /const AccountCenter = lazy/);
  assert.match(app, /'account', 'account-profile', 'account-addresses', 'account-security', 'account-settings'/);
  assert.match(app, /<AccountCenter[\s\S]*wishlist=\{wishlist\}[\s\S]*recentlyViewed=\{recentlyViewedProducts\}/);
});

test('notification preferences have conservative defaults and normalize stored values', () => {
  assert.deepEqual(normalizeNotificationSettings(undefined), {
    orderUpdates: true,
    wishlistUpdates: true,
    promotions: false,
    marketingEmail: false,
  });
  assert.deepEqual(normalizeNotificationSettings({ orderUpdates: false, marketingEmail: true }), {
    orderUpdates: false,
    wishlistUpdates: true,
    promotions: false,
    marketingEmail: true,
  });
  assert.match(account, /customerSettings: notificationSettings/);
  assert.match(account, /Marketing email opt-in/);
});

test('address drafts are normalized, validated, and default addresses sort first', () => {
  const draft = normalizeAddressDraft({
    label: '  Main   home ', fullName: ' Ada   Perera ', phone: '+94 77 123 4567',
    addressLine1: ' 12 Main Road ', addressLine2: '', city: ' Colombo ', district: 'Colombo',
    postalCode: '00100', isDefault: true,
  });
  assert.equal(draft.label, 'Main home');
  assert.equal(draft.fullName, 'Ada Perera');
  assert.deepEqual(validateAddressDraft(draft), []);
  assert.match(validateAddressDraft({ ...draft, phone: '123' })[0], /valid phone number/);

  const addresses = sortCustomerAddresses([
    { id: 'b', ...draft, label: 'Work', isDefault: false },
    { id: 'a', ...draft, label: 'Home', isDefault: true },
  ]);
  assert.equal(addresses[0].id, 'a');
});

test('recently viewed products remain device-local, deduplicated, live, and active-only', () => {
  assert.deepEqual(addRecentlyViewedProduct(['one', 'two'], 'two'), ['two', 'one']);
  assert.deepEqual(addRecentlyViewedProduct(['one'], ' two '), ['two', 'one']);
  assert.deepEqual(buildRecentlyViewedProducts(['two', 'missing', 'one'], [product('one'), product('two', false)]), [product('one')]);
  assert.match(app, /'zyro_recently_viewed'/);
  assert.match(app, /setRecentlyViewedProductIds\(previous => addRecentlyViewedProduct/);
  assert.doesNotMatch(account, /mock|fixture|sampleProducts/iu);
});

test('profile management preserves Firebase Authentication and merges account fields', () => {
  assert.match(account, /await updateProfile\(user, \{ displayName \}\)/);
  assert.match(account, /setDoc\(doc\(db, 'users', user\.uid\)[\s\S]*\{ merge: true \}/);
  assert.match(account, /phoneNumber/);
  assert.match(account, /Avatar upload will be available in a future account phase/);
  assert.match(account, /Member since/);
});

test('address book supports owner-scoped live reads and atomic add, edit, default, and delete operations', () => {
  assert.match(account, /onSnapshot\(collection\(db, 'users', user\.uid, 'addresses'\)/);
  assert.match(account, /const batch = writeBatch\(db\)/);
  assert.match(account, /batch\.set\(addressRef/);
  assert.match(account, /batch\.update\(existing\.ref, \{ isDefault: false/);
  assert.match(account, /batch\.delete\(doc\(db, 'users', user\.uid, 'addresses', address\.id\)\)/);
  assert.match(account, /Confirm delete/);
  assert.match(account, /checkout continues to use its existing delivery form/);
});

test('Firestore address rules are private and validate the exact Phase 1 contract', () => {
  assert.match(rules, /function isValidCustomerAddress\(data\)/);
  assert.match(rules, /match \/users\/\{userId\}\/addresses\/\{addressId\}/);
  assert.match(rules, /allow read: if isOwner\(userId\) \|\| isAdmin\(\)/);
  assert.match(rules, /isOwner\(userId\)[\s\S]*isValidCustomerAddress\(request\.resource\.data\)/);
  assert.match(rules, /data\.keys\(\)\.hasOnly\(\[[\s\S]*'isDefault', 'createdAt', 'updatedAt'/);
  assert.match(rules, /data\.createdAt is timestamp/);
  assert.match(rules, /allow delete: if isOwner\(userId\) \|\| isAdmin\(\)/);
});

test('security foundation reauthenticates password users and exposes verification and login metadata', () => {
  assert.match(account, /EmailAuthProvider\.credential/);
  assert.match(account, /reauthenticateWithCredential\(user, credential\)/);
  assert.match(account, /updatePassword\(user, newPassword\)/);
  assert.match(account, /sendEmailVerification\(user\)/);
  assert.match(account, /user\.emailVerified/);
  assert.match(account, /user\.metadata\.lastSignInTime/);
  assert.match(account, /Device-level session history is not stored yet/);
});

test('account navigation replaces prior placeholders on desktop and mobile', () => {
  assert.match(navbar, /label: 'My Account'[\s\S]*navigateToPage\('account'\)/);
  assert.match(navbar, /label: 'Addresses'[\s\S]*navigateToPage\('account-addresses'\)/);
  assert.match(navbar, /label: 'Settings'[\s\S]*navigateToPage\('account-settings'\)/);
  assert.match(mobileNavigation, /Account Center/);
  assert.match(mobileNavigation, /handleTabClick\('account-security'\)/);
  assert.match(mobileNavigation, /handleTabClick\('account-settings'\)/);
});

test('premium account UI includes loading, empty, error, keyboard, mobile, and motion-safe states', () => {
  assert.match(account, /role="status" aria-label="Loading account information"/);
  assert.match(account, /role="alert"/);
  assert.match(account, /Your address book is empty/);
  assert.match(account, /No orders yet/);
  assert.match(account, /aria-current=\{section === id \? 'page'/);
  assert.match(account, /contentHeadingRef\.current\?\.focus/);
  assert.match(styles, /@media \(max-width: 820px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /@media \(forced-colors: active\)/);
});

test('private Account Center pages are excluded from indexing', async () => {
  const { buildStorefrontSeo } = await import('../src/services/seo/storefrontSeo');
  assert.equal(buildStorefrontSeo({ currentPage: 'account' }).robots, 'noindex, follow');
  assert.equal(buildStorefrontSeo({ currentPage: 'account-addresses' }).robots, 'noindex, follow');
});
