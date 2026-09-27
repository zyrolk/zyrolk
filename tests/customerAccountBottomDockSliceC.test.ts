import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACCOUNT_PAGE_TO_SECTION } from '../src/features/account/accountData';

const read = (path: string): string => readFileSync(path, 'utf8');
const bottomNav = read('src/components/MobileBottomNav.tsx');
const app = read('src/App.tsx');
const account = read('src/features/account/AccountCenter.tsx');
const accountCss = read('src/features/account/accountCenter.css');
const penpotCss = read('src/styles/storefrontPenpot.css');
const navbar = read('src/components/Navbar.tsx');

const extractSignOutHandler = () => {
  const source = account.match(/const handleSignOut = (async \(\) => \{[\s\S]*?\n {2}\});/)?.[1];
  assert.ok(source, 'AccountCenter should define handleSignOut');
  return (deps: {
    signingOut: boolean;
    setSigningOut: (value: boolean) => void;
    onSignOut: () => void | Promise<void>;
    reportClientIssue: (area: string, error: unknown, level: string) => void;
  }) => new Function('signingOut', 'setSigningOut', 'onSignOut', 'reportClientIssue', `return ${source};`)(
    deps.signingOut, deps.setSigningOut, deps.onSignOut, deps.reportClientIssue,
  ) as () => Promise<void>;
};

test('bottom dock contains exactly Home, Categories, Wishlist, Cart and Account', () => {
  const labels = [...bottomNav.matchAll(/tracking-tight">([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Home', 'Categories', 'Wishlist', 'Cart', 'Account']);
  assert.match(bottomNav, /onClick=\{\(\) => handleTabClick\('home'\)\}/);
  assert.match(bottomNav, /onClick=\{\(\) => handleTabClick\('categories'\)\}/);
  assert.match(bottomNav, /onClick=\{\(\) => handleTabClick\('wishlist'\)\}/);
  assert.match(bottomNav, /onClick=\{onOpenCart\}/);
});

test('Account tab always uses the normal account navigation path with one stable label', () => {
  assert.match(bottomNav, /onClick=\{\(\) => handleTabClick\('account'\)\}/);
  assert.equal((bottomNav.match(/aria-label="Go to account"/g) || []).length, 1);
  assert.doesNotMatch(bottomNav, /isAccountPage \? 'Account' : 'Go to account'/);
  assert.match(bottomNav, /aria-current=\{isAccountActive \? 'page' : undefined\}/);
});

test('retired More options sheet and its modal plumbing are gone', () => {
  for (const retired of [
    /mobile-more-menu/, /More options/, /aria-expanded/, /aria-controls/, /AnimatePresence/, /role="dialog"/,
    /aria-modal/, /isMoreMenuOpen/, /menuSheetRef/, /previousFocusRef/, /menuCloseButtonRef/, /event\.key !== 'Tab'/,
    /document\.body\.style\.overflow/, /signOut/, /firebase/, /handleCategoryClick/, /Management Console/,
  ]) {
    assert.doesNotMatch(bottomNav, retired);
  }
  assert.doesNotMatch(app, /isMobileMoreMenuOpen|onMoreMenuOpenChange/);
});

test('App owns one customer sign-out callback and passes account props', () => {
  assert.match(app, /const handleCustomerSignOut = useCallback\(async \(\) => \{\s*await signOut\(auth\);\s*setIsAdminMode\(false\);\s*setCurrentPage\('home'\);\s*\}, \[\]\);/);
  assert.match(app, /const handleOpenAdmin = useCallback\(\(\) => \{\s*setIsAdminMode\(true\);\s*setCurrentPage\('admin'\);\s*\}, \[\]\);/);
  assert.match(app, /<AccountCenter[\s\S]*?onSignOut=\{handleCustomerSignOut\}[\s\S]*?isAdminUser=\{isAdminUser\}[\s\S]*?onOpenAdmin=\{handleOpenAdmin\}[\s\S]*?\/>/);
  assert.equal((app.match(/onAuthStateChanged\(auth,/g) || []).length, 1);
  assert.match(app, /isOverlayOpen=\{isCartOpen \|\| isAuthModalOpen \|\| Boolean\(selectedProduct\) \|\| isFilterDrawerOpen\}/);
});

test('AccountCenter renders a quiet Sign out that only calls the provided callback', () => {
  assert.doesNotMatch(account, /\bsignOut\b/);
  assert.doesNotMatch(account, /import[^;]*\bauth\b[^;]*from '..\/..\/firebase'/);
  assert.match(account, /onSignOut: \(\) => void \| Promise<void>;/);
  assert.match(account, /<div className="zy-account-footer-actions">[\s\S]*?Settings &amp; notifications[\s\S]*?<button type="button" className="zy-account-footer-signout" onClick=\{handleSignOut\} disabled=\{signingOut\}[^>]*><LogOut aria-hidden="true" \/><span>\{signingOut \? 'Signing out…' : 'Sign out'\}<\/span><\/button>/);
  assert.match(accountCss, /\.zy-account-footer-actions button \{[^}]*min-height: 3rem;/);
  assert.match(accountCss, /\.zy-account-footer-signout \{[^}]*color: #dc2626;/);
});

test('Sign out handler invokes the callback once and guards in-flight execution', async () => {
  const build = extractSignOutHandler();
  const pending: boolean[] = [];
  let calls = 0;
  await build({ signingOut: false, setSigningOut: (value) => pending.push(value), onSignOut: async () => { calls += 1; }, reportClientIssue: () => undefined })();
  assert.equal(calls, 1);
  assert.deepEqual(pending, [true, false]);

  let blockedCalls = 0;
  await build({ signingOut: true, setSigningOut: () => undefined, onSignOut: () => { blockedCalls += 1; }, reportClientIssue: () => undefined })();
  assert.equal(blockedCalls, 0);

  const reported: string[] = [];
  const failurePending: boolean[] = [];
  await build({ signingOut: false, setSigningOut: (value) => failurePending.push(value), onSignOut: async () => { throw new Error('offline'); }, reportClientIssue: (area) => reported.push(area) })();
  assert.deepEqual(reported, ['account-sign-out']);
  assert.deepEqual(failurePending, [true, false]);
});

test('Management Console is rendered only for admins and uses the provided callback', () => {
  assert.match(account, /isAdminUser: boolean;/);
  assert.match(account, /\{isAdminUser && <button type="button" onClick=\{onOpenAdmin\}><LayoutDashboard aria-hidden="true" \/> Management Console <ChevronRight aria-hidden="true" \/><\/button>\}/);
  assert.equal((account.match(/Management Console/g) || []).length, 1);
});

test('existing account routes remain unchanged', () => {
  assert.deepEqual(ACCOUNT_PAGE_TO_SECTION, {
    account: 'overview',
    'account-orders': 'orders',
    'account-order-details': 'order-details',
    'account-profile': 'profile',
    'account-addresses': 'addresses',
    'account-security': 'security',
    'account-settings': 'settings',
  });
  assert.match(app, /\['account', 'account-orders', 'account-order-details', 'account-profile', 'account-addresses', 'account-security', 'account-settings'\]\.includes\(currentPage\)/);
});

test('bottom dock active states use scoped Zyro blue while the global palette stays violet', () => {
  assert.match(penpotCss, /--zy-pp-primary: #6547e8;/);
  assert.match(penpotCss, /\.zy-penpot-storefront \.zy-bottom-dock \{\s*--zy-dock-active: #2563eb;/);
  assert.match(penpotCss, /\.zy-penpot-storefront \.zy-mobile-tab\[aria-current="page"\] \{\s*color: var\(--zy-dock-active\) !important;/);
  assert.match(penpotCss, /\.zy-penpot-storefront \.zy-mobile-tab > \.absolute\.bottom-0 \{[^}]*background: var\(--zy-dock-active\);/);
  assert.match(penpotCss, /\.zy-penpot-storefront \.zy-mobile-tab \[class\*="bg-brand-blue"\] \{\s*background: var\(--zy-dock-active\);/);
  assert.match(penpotCss, /\.zy-penpot-storefront \.zy-mobile-tab-cart\[aria-current="page"\] \{[^}]*background: var\(--zy-dock-active\);[^}]*rgba\(37, 99, 235, 0\.5\)/);
  assert.doesNotMatch(penpotCss, /\.zy-(mobile-tab|bottom-dock|mobile-dock)[^{]*\{[^}]*(--zy-pp-primary\)|101, 71, 232)/);
  assert.doesNotMatch(penpotCss, /zy-mobile-sheet|aria-expanded="true"\]\)/);
});

test('desktop Navbar account dropdown, logout and administration stay in place', () => {
  assert.match(navbar, /onClick=\{handleLogout\} className="zy-account-signout"/);
  assert.match(navbar, /setIsAdminMode\(true\); setCurrentPage\('admin'\); setIsProfileOpen\(false\);/);
  assert.match(navbar, /<nav className="zy-mobile-menu-nav" aria-label="Mobile menu">/);
  assert.doesNotMatch(navbar, /onSignOut|onOpenAdmin/);
});
