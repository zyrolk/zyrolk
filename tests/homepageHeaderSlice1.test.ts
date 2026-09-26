import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');

test('Slice 1 keeps the existing header destinations and Deals target', () => {
  assert.doesNotMatch(navbar, />Product Search</);
  assert.match(navbar, /Support/);
  const shoppingNavigation = navbar.match(/const navLinks = \[[\s\S]*?\n  \];/)?.[0] ?? '';
  assert.doesNotMatch(shoppingNavigation, /Support/);
  assert.equal((navbar.match(/label: 'Support'/g) ?? []).length, 1);
  assert.match(navbar, /navigateToPage\('contact'\)/);
  assert.match(navbar, /Hotline \{settings\.contactPhone\}/);
  assert.match(navbar, /Call Zyro\.lk hotline at/);
  assert.match(navbar, /All Categories/);
  assert.match(navbar, /Deals/);
  assert.match(navbar, /New Arrivals/);
  assert.match(navbar, /Best Sellers/);
  assert.match(navbar, /navigateToDeals/);
  assert.match(navbar, /homepage-flash-deals/);
  assert.match(navbar, /Orders/);
  assert.match(navbar, /Wishlist/);
  assert.match(navbar, /Cart/);
  assert.match(navbar, /Account/);
});

test('Slice 1 uses the approved blue marketplace header treatment without changing the dock', () => {
  assert.match(styles, /Slice 1: reference-led header\/navigation presentation/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-announcement-bar[\s\S]*linear-gradient\(105deg, #075bb5[\s\S]*#4c3abf/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-navigation-categories[\s\S]*background: #2563eb/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-header-action[\s\S]*flex-direction: row/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-brand-button img[\s\S]*max-width: 10\.25rem/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-mobile-menu-trigger[\s\S]*min-height/);
  assert.match(styles, /@media \(max-width: 409px\)/);
  assert.match(mobileNavigation, /zy-mobile-tab/);
});

test('mobile header keeps the cart on the first row at common phone widths', () => {
  const css = styles.replace(/\r\n/gu, '\n');
  assert.match(css, /\.zy-penpot-storefront \.zy-mobile-delivery-context \{\n    order: 3;\n    flex: 1 1 0;\n  \}/);
  assert.match(css, /\.zy-penpot-storefront \.zy-header-actions \{\n    order: 4;\n    margin-left: auto;\n  \}/);
  assert.match(css, /\.zy-penpot-storefront \.zy-mobile-menu-trigger \{\n    order: 1;\n    min-width: 44px;\n    min-height: 44px;/);

  const tightBreakpoint = css.match(/@media \(max-width: 409px\) \{\n([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.equal(tightBreakpoint, [
    '  .zy-penpot-storefront .zy-brand-button img {',
    '    max-width: 7.25rem;',
    '  }',
    '',
    '  .zy-penpot-storefront .zy-mobile-delivery-context > b {',
    '    display: none;',
    '  }',
  ].join('\n'));
  assert.equal((css.match(/@media \(max-width: 409px\)/g) ?? []).length, 1);
  assert.doesNotMatch(css, /@media \(max-width: 359px\)/);
});

test('Slice 1 remains presentation-only and scoped to the customer storefront', () => {
  assert.doesNotMatch(styles, /firebase|firestore|onSnapshot|collection\(/iu);
  assert.match(styles, /\.zy-penpot-storefront \.zy-market-header/);
  assert.doesNotMatch(styles, /\.zy-admin|SupplierHub|supplierSync/iu);
});
