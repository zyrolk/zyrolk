import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/App.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const footer = readFileSync('src/components/Footer.tsx', 'utf8');
const productDetail = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const mobileNavigation = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');

test('launch storefront uses the approved generic trust messages', () => {
  for (const message of [
    'Cash on Delivery',
    'Pay when your order arrives.',
    'Islandwide Delivery',
    'Fast delivery across Sri Lanka.',
    'Quality Checked',
    'Carefully selected supplier products.',
    'Customer Support',
    'WhatsApp assistance before and after purchase.',
  ]) {
    assert.match(homepage, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('homepage and product experience do not advertise warranty or return periods', () => {
  const customerSurfaces = [homepage, hero, footer, productDetail];
  for (const source of customerSurfaces) {
    assert.doesNotMatch(source, /7\s*-?\s*day/iu);
    assert.doesNotMatch(source, /Warranty Included/iu);
    assert.doesNotMatch(source, /Authorized Brand Warranty/iu);
  }
});

test('homepage uses the marketplace visual system without changing product handlers', () => {
  for (const className of [
    'zy-market-shelf-categories',
    'zy-market-shelf-featured',
    'zy-market-promo-zone',
    'zy-market-shelf-recommended',
    'zy-market-shelf-latest',
  ]) {
    assert.match(homepage, new RegExp(className));
  }
  assert.match(hero, /zy-hero-stage/);
  assert.match(footer, /zy-market-footer/);
  assert.match(homepage, /onAddToCart=\{handleAddToCart\}/);
  assert.match(homepage, /onViewDetail=\{handleViewProduct\}/);
});

test('launch marketplace is CMS-driven and keeps search in the sticky header', () => {
  assert.match(hero, /configuredSlides\.map/);
  assert.match(hero, /slides\[currentSlide\]\.image/);
  assert.match(hero, /campaignTone\(isPromotionalBadge\(slides\[currentSlide\]\.badge\)/);
  assert.match(hero, /onTouchStart=\{handleTouchStart\}/);
  assert.match(hero, /onTouchEnd=\{handleTouchEnd\}/);
  assert.match(hero, /Everything You Need/);
  assert.match(hero, /Across Every Category/);
  assert.match(hero, /Shop fashion, home, beauty, electronics, lifestyle, accessories and thousands of products in one trusted Sri Lankan marketplace\./);
  assert.match(hero, /marketplaceSafeSubtitle/);
  assert.match(hero, /replacePremiumElectronics/);
  assert.match(hero, /Secure Checkout/);
  assert.doesNotMatch(hero, /PREMIUM_DEFAULT_SLIDES/);
  assert.doesNotMatch(homepage, /zy-home-search-card/);
  assert.match(navbar, /Search products, brands & categories/);
  assert.match(navbar, /Recent searches/);
  assert.match(navbar, /Popular searches/);
  assert.match(navbar, /Browse categories/);
  assert.match(navbar, /Voice search is not enabled/);
  assert.match(homepage, /discountedProducts\.map/);
  assert.match(homepage, /discountedProducts\.length > 0 && <section className="zy-market-promo-zone zy-flash-deals/);
  assert.doesNotMatch(homepage, /No active promotions/);
  assert.match(homepage, /if \(itemsCount === 0\) return \[\]/);
  assert.match(homepage, /storedImage \|\| productImage/);
  assert.match(homepage, /zy-category-tone-/);
  assert.match(homepage, /Premium Hero Slider Banner[\s\S]*order-\[1\]/);
  assert.match(homepage, /zy-market-promo-zone zy-flash-deals order-\[2\]/);
  assert.match(homepage, /zy-market-shelf-categories order-\[3\]/);
  assert.match(homepage, /zy-market-shelf-featured order-\[4\]/);
  assert.match(homepage, /zy-market-shelf-recommended order-\[5\]/);
  assert.match(homepage, /zy-market-shelf-latest order-\[6\]/);
  assert.match(homepage, /order-\[7\][^\n]*max-w-7xl/);
  assert.match(homepage, /zy-market-testimonials order-\[8\]/);
  assert.doesNotMatch(homepage, /zy-community-banner|Join the Zyro\.lk Community|Newsletter/);
});

test('homepage uses live catalog visuals, unique shelves, and mobile-safe product actions', () => {
  assert.match(hero, /liveCatalogVisuals/);
  assert.match(hero, /liveCategoryVisuals/);
  assert.match(homepage, /const usedIds = new Set/);
  assert.match(homepage, /homepageLatestProducts/);
  assert.doesNotMatch(homepage, /newArrivalProducts|bestSellerProducts/);
  assert.match(productCard, /hidden min-h-12[\s\S]*lg:flex/);
  assert.match(productCard, /aria-label=\{`View \$\{product\.name\}`\}/);
  assert.doesNotMatch(productCard, /role="button"/);
});

test('customer account menus retain working storefront and support destinations', () => {
  for (const source of [navbar, mobileNavigation]) {
    assert.match(source, /Quick actions/i);
    assert.match(source, /Wishlist/);
    assert.match(source, /Cart/);
    assert.match(source, /Categories/);
    assert.match(source, /privacy-policy/);
    assert.match(source, /about-us/);
    assert.match(source, /faq/);
    assert.match(source, /Sign Out/);
  }
});
