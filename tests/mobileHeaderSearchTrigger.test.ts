import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontHeader.css', 'utf8');

test('homepage compact mobile header exposes one accessible search trigger', () => {
  assert.match(navbar, /isCompactMobileHeader = currentPage === 'home' && !isAdminMode/);
  assert.match(navbar, /className="zy-navbar-action zy-mobile-search-trigger"/);
  assert.match(navbar, /aria-label="Search products"/);
  assert.match(navbar, /aria-controls="mobile-product-search-panel"/);
  assert.match(navbar, /isMobileSearchOpen \? closeMobileSearch\(\) : openMobileSearch\(\)/);
});

test('mobile search reuses the existing search box and restores focus on close', () => {
  assert.match(navbar, /searchInputRefs\.current\.mobile\?\.focus\(\)/);
  assert.match(navbar, /mobileSearchTriggerRef\.current\?\.focus\(\)/);
  assert.match(navbar, /\(!isCompactMobileHeader \|\| isMobileSearchOpen\) && renderSearchBox\('mobile'\)/);
  assert.match(navbar, /if \(isCompactMobileHeader && isMobileSearchOpen\) \{[\s\S]*?closeMobileSearch\(\);/);
  assert.match(navbar, /setIsMobileSearchOpen\(false\);/);
});

test('compact mobile presentation hides delivery copy and keeps 44px controls', () => {
  assert.match(styles, /\.zy-penpot-storefront \.zy-compact-mobile-header \.zy-mobile-delivery-context \{\s*display: none;/);
  assert.match(styles, /grid-template-columns: 44px minmax\(0, 1fr\) 44px 44px/);
  assert.match(styles, /\.zy-mobile-search-trigger \{\s*display: inline-flex;/);
  assert.match(styles, /width: 44px;\s*min-width: 44px;\s*height: 44px/);
  assert.match(styles, /\.zy-navbar-mobile-search\.zy-compact-mobile-search\.is-open \{\s*display: block;/);
});

test('invalid configured logos fall back to readable Zyro.lk text', () => {
  assert.match(navbar, /const logoUrl = settings\?\.logoUrl\?\.trim\(\) \|\| '';/);
  assert.match(navbar, /const \[logoImageFailed, setLogoImageFailed\] = useState\(false\);/);
  assert.match(navbar, /onError=\{\(\) => setLogoImageFailed\(true\)\}/);
  assert.match(navbar, /settings\?\.storeName \? settings\.storeName\.split\('\.'\)\[0\] : 'Zyro'/);
});
