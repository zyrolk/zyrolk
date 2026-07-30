import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const megaMenu = readFileSync('src/components/MarketplaceMegaMenu.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontHeader.css', 'utf8');

test('premium header presents marketplace assurance and search-first discovery', () => {
  assert.match(navbar, /Islandwide Delivery/);
  assert.match(navbar, /Easy Returns/);
  assert.match(navbar, /Secure Payments/);
  assert.match(navbar, /Product Search/);
  assert.match(navbar, /Search products, brands and categories\.\.\./);
  assert.doesNotMatch(navbar, /handleVoiceSearch|SpeechRecognition|AI Shopping Assistant/);
  assert.match(navbar, /Voice search is unavailable in this launch version/);
  assert.match(navbar, /title="Voice search is unavailable in this launch version"[\s\S]*disabled/);
  assert.match(navbar, /Open product discovery search/);
});

test('desktop and tablet navigation retain every requested customer destination', () => {
  for (const destination of ['Categories', 'Deals', 'New Arrivals', 'Best Sellers', 'Brands', "Today's Offers", 'Support']) {
    assert.match(navbar, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  for (const action of ['Orders', 'Wishlist', 'Notifications', 'Cart', 'Account']) {
    assert.match(navbar, new RegExp(`>${action}<`));
  }
});

test('mega menu projects live categories and configured media without mock catalogue data', () => {
  assert.match(megaMenu, /categories\.filter/);
  assert.match(megaMenu, /activeCategory\.imageUrl/);
  assert.match(megaMenu, /activeCategory\.subcategories/);
  assert.match(megaMenu, /onSelectCategory\(category\.id\)/);
  assert.doesNotMatch(megaMenu, /mock|placeholder product|demo product/iu);
});

test('mobile navigation exposes the five requested marketplace actions in order', () => {
  const labels = ['Home', 'Categories', 'Wishlist', 'Cart', 'Account'];
  let previousIndex = -1;
  for (const label of labels) {
    const index = mobileNavigation.indexOf(`>${label}</span>`);
    assert.ok(index > previousIndex, `${label} should follow the previous mobile destination`);
    previousIndex = index;
  }
});

test('header presentation covers responsive, accessible and reduced-motion states', () => {
  assert.match(styles, /@media \(max-width: 1199px\)/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /@media \(max-width: 359px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /min-height: 44px/);
});
