import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const phaseOneHome = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const productShelf = readFileSync('src/components/StorefrontProductShelf.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const footer = readFileSync('src/components/Footer.tsx', 'utf8');
const productDetail = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');

test('customer-facing surfaces do not advertise warranty or return periods', () => {
  for (const source of [app, phaseOneHome, hero, footer, productDetail]) {
    assert.doesNotMatch(source, /7\s*-?\s*day/iu);
    assert.doesNotMatch(source, /Warranty Included/iu);
    assert.doesNotMatch(source, /Authorized Brand Warranty/iu);
  }
});

test('the customer home route renders the isolated Phase 1 presentation with existing handlers', () => {
  assert.match(app, /currentPage === 'home'[\s\S]*<MarketplaceHomePhase1/);
  assert.match(app, /products=\{activeProducts\}/);
  assert.match(app, /categories=\{storefrontCategories\}/);
  assert.match(app, /categoryVisuals=\{homepageCategories\}/);
  assert.match(app, /discountedProducts=\{discountedProducts\}/);
  assert.match(app, /featuredProducts=\{trendingProducts\}/);
  assert.match(app, /newArrivalProducts=\{newArrivalProducts\}/);
  assert.match(app, /bestSellerProducts=\{bestSellerProducts\}/);
  assert.match(app, /recommendedProducts=\{recommendedProducts\}/);
  assert.match(app, /onAddToCart=\{handleAddToCart\}/);
  assert.match(app, /onToggleWishlist=\{handleToggleWishlist\}/);
  assert.match(app, /onViewDetail=\{handleViewProduct\}/);
});

test('Phase 1 uses live category visuals and prop-driven live product shelves', () => {
  assert.match(app, /if \(itemsCount === 0\) return \[\]/);
  assert.match(app, /storedImage \|\| productImage/);
  assert.match(phaseOneHome, /const hasCategories = categoryVisuals\.length > 0/);
  assert.match(phaseOneHome, /categoryVisuals\.map/);
  assert.match(phaseOneHome, /PLACEHOLDER_TILES/);
  assert.match(phaseOneHome, /Active categories with published products will appear here automatically\./);
  assert.match(phaseOneHome, /import StorefrontProductShelf from '\.\/StorefrontProductShelf'/);
  assert.match(phaseOneHome, /products=\{discountedProducts\}/);
  assert.match(phaseOneHome, /products=\{featuredProducts\}/);
  assert.match(phaseOneHome, /products=\{newArrivalProducts\}/);
  assert.match(phaseOneHome, /products=\{bestSellerProducts\}/);
  assert.match(phaseOneHome, /products=\{recommendedProducts\}/);
  assert.match(productShelf, /products\.map/);
  assert.match(productShelf, /<ProductCard/);
  assert.doesNotMatch(phaseOneHome, /countdown|placeholder product|demo product/iu);
});

test('CMS hero keeps campaign behavior and marketplace-safe messaging', () => {
  assert.match(hero, /configuredSlides\.map/);
  assert.match(hero, /activeSlide\.image/);
  assert.match(hero, /activeSlide\.ctaUrl/);
  assert.match(hero, /normalizeSlideSpeed\(settings\?\.autoSlideSpeed\)/);
  assert.match(hero, /onTouchStart=\{handleTouchStart\}/);
  assert.match(hero, /onTouchEnd=\{handleTouchEnd\}/);
  assert.match(hero, /Everything you need\./);
  assert.match(hero, /One trusted marketplace\./);
  assert.match(hero, /Shop fashion, home, beauty, electronics, lifestyle, accessories and thousands of products in one trusted Sri Lankan marketplace\./);
  assert.match(hero, /const displaySubtitle = MARKETPLACE_MESSAGE/);
  assert.match(hero, /replacePremiumElectronics/);
  assert.doesNotMatch(hero, /PREMIUM_DEFAULT_SLIDES/);
});

test('sticky premium navigation keeps the existing search and destination logic', () => {
  assert.match(navbar, /zy-market-header sticky top-0/);
  assert.match(navbar, /zy-market-header-shell/);
  assert.match(navbar, /Search products, brands & categories/);
  assert.match(navbar, /Recent searches/);
  assert.match(navbar, /Popular searches/);
  assert.match(navbar, /Browse categories/);
  assert.match(navbar, /onSelectProduct\(product\)/);
  assert.match(navbar, /onSelectCategory\(categoryId\)/);
});

test('Phase 1 does not alter ProductCard interaction contracts', () => {
  assert.match(productCard, /onAddToCart/);
  assert.match(productCard, /onToggleWishlist/);
  assert.match(productCard, /onViewDetail/);
  assert.match(productCard, /aria-label=\{`View \$\{product\.name\}`\}/);
  assert.doesNotMatch(productCard, /role="button"/);
});

test('Navbar V2 exposes approved account actions without inventing customer routes', () => {
  assert.match(navbar, /label: 'My Account'/);
  assert.match(navbar, /label: 'Orders'/);
  assert.match(navbar, /label: 'Wishlist'[^\n]*navigateToPage\('wishlist'\)/);
  assert.match(navbar, /label: 'Addresses'/);
  assert.match(navbar, /label: 'Notifications'/);
  assert.match(navbar, /label: 'Coupons'/);
  assert.match(navbar, /label: 'Support'[^\n]*navigateToPage\('contact'\)/);
  assert.match(navbar, /label: 'Settings'/);
  assert.match(navbar, /Coming soon/);
  assert.match(navbar, /onClick=\{handleLogout\}/);
  assert.match(navbar, /> Logout/);
  assert.match(navbar, /onClick=\{onOpenCart\}/);
  assert.match(navbar, /zy-mobile-market-menu/);
});

test('existing mobile account sheet retains working storefront and support destinations', () => {
  assert.match(mobileNavigation, /Quick actions/i);
  assert.match(mobileNavigation, /Wishlist/);
  assert.match(mobileNavigation, /Cart/);
  assert.match(mobileNavigation, /Categories/);
  assert.match(mobileNavigation, /privacy-policy/);
  assert.match(mobileNavigation, /about-us/);
  assert.match(mobileNavigation, /faq/);
  assert.match(mobileNavigation, /Sign Out/);
});
