import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(path, 'utf8');
const navbar = read('src/components/Navbar.tsx');
const headerCss = read('src/styles/storefrontHeader.css');
const bottomNav = read('src/components/MobileBottomNav.tsx');

const mobileMenu = navbar.match(/id="mobile-header-navigation"[\s\S]*?<\/nav>\s*<\/motion\.div>/)?.[0] || '';
const desktopNavLinks = navbar.match(/const navLinks = \[[\s\S]*?\n {2}\];/)?.[0] || '';

test('mobile hamburger browse section uses Home, Categories, New Arrivals and Deals only', () => {
  assert.ok(mobileMenu, 'mobile menu block should be present');
  assert.match(mobileMenu, /renderMobileMenuRow\('home', 'Home', Home, \(\) => navigateToPage\('home'\)\)/);
  assert.match(mobileMenu, /renderMobileMenuRow\('categories', 'Categories', Grid3X3, \(\) => navigateToPage\('categories'\)\)/);
  assert.match(navbar, /const mobileBrowseLinks = \['new-arrivals', 'deals'\]/);
  assert.match(mobileMenu, /mobileBrowseLinks\.map\(/);
  assert.doesNotMatch(mobileMenu, /navLinks\.map/);
  assert.doesNotMatch(mobileMenu, /Today's Offers|today-offers|Best Sellers|best-sellers/);
});

test('signed-in account rows use existing account destinations', () => {
  const accountLinks = navbar.match(/const mobileAccountLinks = \[[\s\S]*?\n {2}\];/)?.[0] || '';
  assert.match(accountLinks, /\{ id: 'account-orders', label: 'My Orders'/);
  assert.match(accountLinks, /\{ id: 'wishlist', label: 'Wishlist'/);
  assert.match(accountLinks, /\{ id: 'account-profile', label: 'Profile'/);
  assert.match(accountLinks, /\{ id: 'account-addresses', label: 'Addresses'/);
  assert.match(mobileMenu, /\{user && \([\s\S]*?mobileAccountLinks\.map\(\(\{ id, label, icon: Icon \}\) => renderMobileMenuRow\(id, label, Icon, \(\) => navigateToPage\(id\)\)\)/);
  assert.match(mobileMenu, /onClick=\{user \? \(\) => navigateToPage\('account'\) : \(\) => \{ setIsMobileMenuOpen\(false\); onOpenAuthModal\(\); \}\}>\{user \? 'My Account' : 'Sign in'\}/);
});

test('Browse Categories is the single mobile menu route to categories', () => {
  assert.doesNotMatch(navbar, /zy-mobile-category-list/);
  assert.doesNotMatch(mobileMenu, /categories\.filter/);
  assert.doesNotMatch(mobileMenu, /View all categories|Shop by category|mobile-menu-categories|all-categories/);
  assert.equal((mobileMenu.match(/navigateToPage\('categories'\)/g) || []).length, 1);
  assert.doesNotMatch(headerCss, /zy-mobile-category-list/);
});

test('help section keeps existing support, FAQ, hotline and WhatsApp destinations', () => {
  assert.match(mobileMenu, /renderMobileMenuRow\('support', supportNavLink\.label, Headphones, supportNavLink\.action\)/);
  assert.match(navbar, /const supportNavLink = \{ label: 'Support', icon: MessageCircle, action: \(\) => navigateToPage\('contact'\) \};/);
  assert.match(mobileMenu, /renderMobileMenuRow\('faq', 'FAQ', CircleHelp, \(\) => navigateToPage\('faq'\)\)/);
  assert.match(mobileMenu, /\{settings\?\.contactPhone && \([\s\S]*?href=\{`tel:\$\{settings\.contactPhone\}`\} aria-label=\{`Call Zyro\.lk hotline at \$\{settings\.contactPhone\}`\}/);
  assert.match(navbar, /const supportWhatsApp = \(settings\?\.whatsappNumber \|\| ''\)\.replace\(\/\[\^0-9\]\/gu, ''\);/);
  assert.match(mobileMenu, /href=\{`https:\/\/wa\.me\/\$\{supportWhatsApp\}`\} target="_blank" rel="noopener noreferrer"/);
});

test('menu closes on outside tap and Escape, and restores background scrolling', () => {
  const menuEffect = navbar.match(/useEffect\(\(\) => \{\n {4}if \(!isMobileMenuOpen\) return;[\s\S]*?\n {2}\}, \[isMobileMenuOpen\]\);/)?.[0] || '';
  assert.match(menuEffect, /document\.addEventListener\('pointerdown', handleOutsideMenuPointer\)/);
  assert.match(menuEffect, /mobileMenuRef\.current\?\.contains\(target\)/);
  assert.match(menuEffect, /setIsMobileMenuOpen\(false\)/);
  assert.match(menuEffect, /const previousOverflow = document\.body\.style\.overflow;/);
  assert.match(menuEffect, /if \(shouldLockScroll\) document\.body\.style\.overflow = 'hidden';/);
  assert.match(menuEffect, /document\.removeEventListener\('pointerdown', handleOutsideMenuPointer\);/);
  assert.match(menuEffect, /if \(shouldLockScroll\) document\.body\.style\.overflow = previousOverflow;/);
  assert.match(navbar, /className="zy-mobile-menu-scrim"[\s\S]{0,60}onClick=\{\(\) => setIsMobileMenuOpen\(false\)\}/);
  assert.match(navbar, /if \(event\.key === 'Escape'\) \{[\s\S]{0,120}setIsMobileMenuOpen\(false\);/);
});

test('hamburger menu has its own accessible label and 44px+ rows', () => {
  assert.match(mobileMenu, /<nav className="zy-mobile-menu-nav" aria-label="Mobile menu">/);
  assert.match(bottomNav, /aria-label="Mobile storefront navigation"/);
  assert.doesNotMatch(mobileMenu, /Mobile storefront navigation/);
  assert.match(headerCss, /\.zy-mobile-menu-row \{[^}]*min-height: 48px;/);
  assert.match(headerCss, /\.zy-mobile-menu-account button \{[^}]*min-height: 44px;/);
  assert.match(headerCss, /\.zy-mobile-menu-label \{[^}]*font-size: \.6875rem;[^}]*text-transform: uppercase;/);
  assert.doesNotMatch(headerCss, /\.zy-mobile-menu[^{]*\{[^}]*(6547e8|101, ?71, ?232|zy-pp-primary)/);
});

test('desktop navigation, search, cart and bottom dock stay unchanged', () => {
  assert.match(desktopNavLinks, /\{ id: 'deals', label: 'Deals', icon: Tag, action: navigateToDeals \}/);
  assert.match(desktopNavLinks, /\{ id: 'new-arrivals', label: 'New Arrivals', icon: Sparkles, action: \(\) => navigateToPage\('products'\) \}/);
  assert.match(desktopNavLinks, /\{ id: 'best-sellers', label: 'Best Sellers', icon: BarChart3, action: \(\) => navigateToPage\('products'\) \}/);
  assert.match(desktopNavLinks, /\{ id: 'today-offers', label: "Today's Offers", icon: Tag, action: navigateToDeals \}/);
  assert.match(navbar, /<nav aria-label="Primary storefront navigation">\s*\{navLinks\.map\(\(link\) => \(/);
  assert.match(navbar, /renderSearchBox\('mobile'\)/);
  assert.match(navbar, /aria-controls="mobile-header-navigation"/);
  assert.match(bottomNav, /handleTabClick\('account-security'\)/);
  assert.match(bottomNav, /zy-mobile-tab/);
});
