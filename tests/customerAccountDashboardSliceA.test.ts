import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACCOUNT_PAGE_TO_SECTION, ACCOUNT_SECTION_TO_PAGE } from '../src/features/account/accountData';

const read = (path: string): string => readFileSync(path, 'utf8');
const account = read('src/features/account/AccountCenter.tsx');
const styles = read('src/features/account/accountCenter.css');
const penpot = read('src/styles/storefrontPenpot.css');
const navbar = read('src/components/Navbar.tsx');
const bottomNav = read('src/components/MobileBottomNav.tsx');

const overviewBlock = account.match(/\{section === 'overview' && \([\s\S]*?\n {8}\)\}/)?.[0] || '';
const penpotAccountBlock = penpot.match(/\/\* Account \*\/[\s\S]*?\/\* Unified loading/)?.[0] || '';

test('account routes and page IDs are unchanged', () => {
  assert.deepEqual(ACCOUNT_SECTION_TO_PAGE, {
    overview: 'account',
    orders: 'account-orders',
    'order-details': 'account-order-details',
    profile: 'account-profile',
    addresses: 'account-addresses',
    security: 'account-security',
    settings: 'account-settings',
  });
  for (const [page, section] of Object.entries(ACCOUNT_PAGE_TO_SECTION)) {
    assert.equal(ACCOUNT_SECTION_TO_PAGE[section], page);
  }
});

test('overview quick actions target existing account pages without a profile tile', () => {
  assert.ok(overviewBlock, 'overview block should be present');
  const quickActions = account.match(/const quickActions[\s\S]*?\n {2}\];/)?.[0] || '';
  assert.match(quickActions, /label: 'My Orders'[\s\S]*onSelect: \(\) => navigateSection\('orders'\)/);
  assert.match(quickActions, /label: 'Wishlist'[\s\S]*onSelect: \(\) => onNavigate\('wishlist'\)/);
  assert.match(quickActions, /label: 'Addresses'[\s\S]*onSelect: \(\) => navigateSection\('addresses'\)/);
  assert.match(quickActions, /label: 'Security'[\s\S]*onSelect: \(\) => navigateSection\('security'\)/);
  assert.doesNotMatch(quickActions, /label: 'Profile'/);
  assert.match(overviewBlock, /className="zy-account-quick-actions"/);
});

test('profile hero edits through the existing profile route and uses the existing completeness state', () => {
  assert.match(overviewBlock, /className="zy-account-profile-card"[\s\S]*onClick=\{\(\) => navigateSection\('profile'\)\}>[\s\S]*Edit profile/);
  assert.match(account, /const profileComplete = Boolean\(\(profile\.displayName \|\| user\?\.displayName\) && profile\.phoneNumber\);/);
  assert.match(account, /Add your phone number to finish your profile\./);
  assert.doesNotMatch(account, /Needs attention/);
  assert.doesNotMatch(account, /Device-local history/);
});

test('recent orders keep the existing open action, status value and compact empty state', () => {
  assert.match(overviewBlock, /orders\.slice\(0, 4\)/);
  assert.match(overviewBlock, /onClick=\{\(\) => \{ setSelectedOrderId\(order\.id\); navigateSection\('order-details'\); \}\}/);
  assert.match(overviewBlock, /className=\{`status-\$\{order\.status\.toLowerCase\(\)\.replace\(\/\[\^a-z\]\/gu, ''\)\}`\}>\{order\.status\}/);
  assert.match(overviewBlock, /zy-account-empty is-compact"><PackageCheck \/><strong>No orders yet/);
  assert.match(styles, /\.zy-account-empty\.is-compact \{ min-height: 0;/);
  assert.match(styles, /\.zy-account-order-list b \{[^}]*color: #92400e; background: #fef3c7;/);
  assert.match(styles, /status-confirmed, \.status-processing, \.status-packed, \.status-shipped\) \{ color: #1d4ed8; background: #eff6ff; \}/);
  assert.match(styles, /status-delivered\) \{ color: #166534; background: #dcfce7; \}/);
  assert.match(styles, /b\.status-cancelled \{ color: #991b1b; background: #fee2e2; \}/);
});

test('recently viewed, help and settings use existing props and routes only', () => {
  assert.match(overviewBlock, /onClick=\{\(\) => onViewProduct\(product\)\}/);
  assert.match(overviewBlock, /Products you view will appear here\./);
  assert.match(overviewBlock, /onClick=\{\(\) => onNavigate\('contact'\)\}/);
  assert.match(overviewBlock, /onClick=\{\(\) => onNavigate\('faq'\)\}/);
  assert.match(account, /const supportPhone = settings\?\.contactPhone\?\.trim\(\) \|\| '';/);
  assert.match(overviewBlock, /onClick=\{\(\) => navigateSection\('settings'\)\}/);
  assert.doesNotMatch(account, /signOut/);
});

test('account handlers, listeners and Firebase calls remain wired', () => {
  for (const handler of [
    'handleProfileSave', 'openNewAddress', 'openAddressEdit', 'closeAddressForm', 'handleAddressSave',
    'handleSetDefaultAddress', 'handleDeleteAddress', 'handleSettingsSave', 'handlePasswordChange', 'handleVerificationEmail',
  ]) {
    assert.match(account, new RegExp(`const ${handler} = `), `${handler} should stay defined`);
  }
  assert.match(account, /onSnapshot\(doc\(db, 'users', user\.uid\)/);
  assert.match(account, /where\('customerUid', '==', user\.uid\)/);
  assert.match(account, /collection\(db, 'users', user\.uid, 'addresses'\)/);
  assert.match(account, /updateProfile\(user, \{ displayName \}\)/);
  assert.match(account, /reauthenticateWithCredential\(user, credential\)/);
  assert.match(account, /sendEmailVerification\(user\)/);
  assert.match(account, /<CustomerOrdersView/);
});

test('desktop sidebar keeps every account section', () => {
  for (const [id, label] of [
    ['overview', 'Overview'], ['orders', 'My Orders'], ['profile', 'Profile'],
    ['addresses', 'Addresses'], ['security', 'Security'], ['settings', 'Settings'],
  ]) {
    assert.match(account, new RegExp(`\\{ id: '${id}', label: '${label}'`));
  }
  assert.match(account, /<aside className="zy-account-sidebar" aria-label="Account sections">/);
  assert.match(styles, /\.zy-account-sidebar \{\s*position: sticky;/);
  assert.match(styles, /@media \(min-width: 1180px\) \{\s*\.zy-account-overview-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test('mobile overview no longer relies on the section tab strip', () => {
  const mobileRules = styles.match(/@media \(max-width: 820px\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(mobileRules, /\.zy-account-sidebar \{ display: none; \}/);
  assert.match(mobileRules, /\.zy-account-back \{ display: inline-flex;/);
  assert.doesNotMatch(styles, /grid-template-columns: repeat\(6, minmax\(78px, 1fr\)\)/);
  assert.match(account, /\{!isOverview && <button type="button" className="zy-account-back" onClick=\{\(\) => navigateSection\('overview'\)\}>/);
});

test('account area uses scoped royal blue instead of the storefront violet', () => {
  assert.match(styles, /--account-blue: #2563eb;/);
  assert.match(styles, /background: linear-gradient\(135deg, #1e3a8a, #2563eb 60%, #3b82f6\);/);
  assert.match(penpotAccountBlock, /--account-blue: #2563eb;/);
  assert.doesNotMatch(penpotAccountBlock, /--zy-pp-primary/);
  assert.doesNotMatch(penpotAccountBlock, /101, 71, 232/);
  assert.match(penpot, /--zy-pp-primary: #6547e8;/);
});

test('mobile account pages keep WhatsApp reachable without the floating button covering cards', () => {
  const mobileRules = styles.match(/@media \(max-width: 820px\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(mobileRules, /body:has\(\.zy-account-center\) \.zy-floating-whatsapp \{ display: none; \}/);
  assert.match(account, /const supportWhatsApp = \(settings\?\.whatsappNumber \|\| ''\)\.replace\(\/\[\^0-9\]\/gu, ''\);/);
  assert.match(overviewBlock, /href=\{`https:\/\/wa\.me\/\$\{supportWhatsApp\}`\} target="_blank" rel="noopener noreferrer"/);
  assert.match(read('src/components/FloatingWhatsApp.tsx'), /window\.open\(`https:\/\/wa\.me\/\$\{cleanNumber\}`/);
  assert.match(styles, /\.zy-account-center \{[^}]*width: min\(1280px, calc\(100% - 11rem\)\);/);
});

test('profile hero groups identity, status and edit action in a compact grid', () => {
  assert.match(overviewBlock, /<p className=\{`zy-account-profile-card-status \$\{profileComplete \? 'is-complete' : 'is-incomplete'\}`\}>/);
  assert.match(styles, /grid-template-areas: "avatar copy" "status status" "action action"; gap: \.5rem/);
  assert.match(styles, /\.zy-account-profile-card > button \{ grid-area: action;[^}]*min-height: 2\.75rem;/);
});

test('sidebar protection note uses customer-facing copy', () => {
  assert.match(account, /Your account and sign-in are protected\./);
  assert.doesNotMatch(account, /Firebase Authentication secures/);
});

test('bottom navigation and hamburger menu remain unchanged', () => {
  assert.match(navbar, /label: 'My Account'/);
  assert.match(bottomNav, /Account Center/);
  assert.match(bottomNav, /handleTabClick\('account-security'\)/);
  assert.match(bottomNav, /handleTabClick\('account-settings'\)/);
});
