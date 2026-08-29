import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const main = readFileSync('src/main.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const checkout = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');

test('Penpot redesign is isolated to the customer storefront and loaded last', () => {
  const headerStyles = main.indexOf("import './styles/storefrontHeader.css'");
  const penpotStyles = main.indexOf("import './styles/storefrontPenpot.css'");
  assert.ok(headerStyles >= 0 && penpotStyles > headerStyles);
  assert.match(app, /!isAdminMode \? 'zy-penpot-storefront' : ''/);
  assert.match(app, /data-storefront-page=/);
  assert.match(styles, /Every rule is scoped to \.zy-penpot-storefront/);
  assert.doesNotMatch(styles, /\.zy-admin|\.supplier-|SupplierHub/u);
});

test('Penpot tokens and applied Inter Tight typography are represented exactly', () => {
  for (const token of ['#f6f7fb', '#ffffff', '#6547e8', '#4e35be', '#ff6b3d', '#14966a', '#f2a51a', '#d92d4b', '#141721', '#5f6675', '#9299a8', '#e3e6ed']) {
    assert.match(styles, new RegExp(token, 'i'));
  }
  assert.match(styles, /--font-sans: "Inter Tight", "Inter"/);
  assert.match(styles, /--font-display: "Inter Tight", "Inter"/);
});

test('390px mobile product cards use a compact two-column grid without removing commerce actions', () => {
  assert.match(app, /zy-product-grid grid grid-cols-2/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.zy-penpot-storefront \.zy-product-grid[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(productCard, /onAddToCart\(product\)/);
  assert.match(productCard, /zy-product-single-action/);
  assert.match(productCard, /onViewDetail\(product\)/);
  assert.match(productCard, /onToggleWishlist\(product\)/);
  assert.match(productCard, /zy-product-card-trust/);
  assert.match(productCard, /settings\?\.enableCOD !== false/);
  assert.match(productCard, /settings\?\.deliveryCharge === 0/);
});

test('mobile P1 cascade wins over legacy horizontal shelves and oversized cards', () => {
  assert.match(styles, /\.zy-penpot-storefront \.zy-ai-hero-stage \{\s*min-height: auto;/);
  assert.doesNotMatch(styles, /min-height: 24rem/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-storefront-product-shelf-grid \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?scroll-snap-type: none;/);
  assert.match(styles, /:is\(\.zy-storefront-product-shelf-item, \.zy-storefront-product-skeleton\) \{[\s\S]*?width: auto;[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-product-card \{[\s\S]*?height: 20\.25rem;[\s\S]*?grid-template-rows: 8\.75rem/);
  assert.match(styles, /\.zy-product-card-wishlist \{[\s\S]*?width: 2\.75rem;[\s\S]*?height: 2\.75rem;/);
  assert.match(styles, /\.zy-product-card-action-grid \{[\s\S]*?height: 2\.75rem;[\s\S]*?2\.75rem/);
  assert.match(styles, /\.zy-product-single-action \{[\s\S]*?width: 100%/);
});

test('mobile categories, listing and filters follow the Penpot composition', () => {
  assert.match(styles, /\.zy-penpot-storefront \.zy-categories-grid \{[\s\S]*?display: grid;[\s\S]*?repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?overflow: visible;/);
  assert.match(styles, /\.zy-category-collection-item \{[\s\S]*?width: auto;[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.zy-catalog-page > \.zy-page-banner \{\s*display: none;/);
  assert.match(styles, /\.zy-filter-sheet::before/);
  assert.match(styles, /\.zy-filter-sheet \.zy-penpot-filters fieldset > div \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(app, /zy-filter-sheet-reset/);
  assert.match(app, /onClick=\{clearAllFilters\}/);
});

test('mobile search, filter sheet, sort and five-destination dock keep existing navigation state', () => {
  assert.match(navbar, /zy-mobile-delivery-context/);
  assert.match(navbar, /role="combobox"/);
  assert.match(navbar, /zy-search-empty/);
  assert.match(navbar, /zy-search-empty-clear/);
  assert.match(navbar, /zy-market-header sticky top-0/);
  assert.match(styles, /--zy-mobile-storefront-header-height/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-market-header[\s\S]*background: #fff/);
  assert.match(styles, /\.zy-search-suggestions[\s\S]*position: fixed/);
  assert.match(styles, /\.zy-search-empty-clear[\s\S]*min-height: 2\.75rem/);
  assert.match(app, /zy-filter-sheet/);
  assert.match(app, /zy-mobile-sort-control/);
  assert.match(styles, /@keyframes zy-penpot-sheet-up/);
  for (const label of ['Home', 'Categories', 'Wishlist', 'Cart', 'Account']) assert.match(mobileNavigation, new RegExp(`>${label}<`));
  assert.match(mobileNavigation, /handleTabClick\('account'\)/);
  assert.match(mobileNavigation, /isAccountPage/);
});

test('Penpot presentation covers home, listing, details, wishlist, checkout, account and shared states', () => {
  for (const selector of [
    'zy-ai-hero-stage', 'zy-categories-intro', 'zy-page-banner', 'zy-product-experience',
    'zy-personalization-hero', 'zy-premium-checkout', 'zy-account-center', 'zy-storefront-connection-state',
  ]) assert.match(styles, new RegExp(selector));
  assert.match(checkout, /server-authoritative totals|verified again by the secure checkout service/);
  assert.match(checkout, /requiresPriceReconfirmation/);
  assert.match(checkout, /idempotencyKey/);
});

test('responsive and accessibility safeguards cover target breakpoints and user preferences', () => {
  assert.match(styles, /@media \(max-width: 389px\)/);
  assert.match(styles, /@media \(max-width: 360px\)/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1023px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /min-height: 2\.75rem/);
  assert.match(mobileNavigation, /aria-current=/);
  assert.match(productCard, /aria-pressed=\{isWishlisted\}/);
});
