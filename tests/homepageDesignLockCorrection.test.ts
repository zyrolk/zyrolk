import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const previewCard = readFileSync('src/components/HomepagePreviewProductCard.tsx', 'utf8');
const preview = readFileSync('src/services/storefront/homepagePreviewPresentation.ts', 'utf8');
const homepageStyles = readFileSync('src/styles/homepagePreview.css', 'utf8');
const footerStyles = readFileSync('src/index.css', 'utf8');
const mobileNav = readFileSync('src/components/MobileBottomNav.tsx', 'utf8');

test('reference preview hero uses one clean art cluster without the legacy preview frame', () => {
  assert.match(hero, /zy-reference-hero-art/u);
  const previewBranch = hero.slice(hero.indexOf('{isReferencePreview ? ('), hero.indexOf(') : ('));
  assert.doesNotMatch(previewBranch, /zy-ai-hero-visual-frame|zy-ai-hero-product-card|zy-ai-hero-campaign/u);
  assert.doesNotMatch(hero, /zy-ai-hero-visual-frame|zy-ai-hero-category-stack|zy-ai-hero-product-card|zy-ai-hero-campaign/u);
  assert.match(hero, /displayTitle/u);
  assert.match(hero, /displayCta/u);
});

test('preview products stay presentation-only and use customer-safe wording', () => {
  const shelfMatches = [...preview.matchAll(/shelf: '(\w+(?:-\w+)*)'/gu)].map(match => match[1]);
  assert.equal(shelfMatches.length, 6);
  assert.deepEqual(new Set(shelfMatches), new Set(['recommended']));
  assert.doesNotMatch(preview, /collection visual|preview badge|fake|mock|sample|discount|rating|stock|sold/iu);
  assert.doesNotMatch(previewCard, />Preview<|presentation preview only|developer|debug/iu);
  assert.doesNotMatch(previewCard, /from ['"]\.\/ProductCard['"]|Cart|Wishlist|Checkout|Firestore|onAddToCart|onToggleWishlist/iu);
});

test('production shelves omit empty Flash Deals, Featured and Best Seller shells', () => {
  assert.match(homepage, /const hasLiveProducts = shelf\.products\.length > 0/u);
  assert.match(homepage, /if \(loading \|\| hasLiveProducts\)/u);
  assert.match(homepage, /if \(!shouldShowPreviewShelf \|\| !previewPresentation\) return null/u);
  assert.match(homepage, /products: discountedProducts/u);
  assert.match(homepage, /products: featuredProducts/u);
  assert.match(homepage, /products: bestSellerProducts/u);
  assert.doesNotMatch(homepage, /featuredProducts\.push|bestSellerProducts\.push|discountedProducts\.push/u);
});

test('live and preview homepage cards share presentation tokens without changing commerce props', () => {
  assert.match(homepageStyles, /--zy-home-card-radius/u);
  assert.match(homepageStyles, /zy-launch-home .*zy-product-card/u);
  assert.match(homepageStyles, /zy-launch-home .*zy-home-preview-product-card/u);
  assert.match(homepage, /onAddToCart=\{onAddToCart\}/u);
  assert.match(homepage, /onToggleWishlist=\{onToggleWishlist\}/u);
  assert.match(homepage, /onViewDetail=\{onViewDetail\}/u);
});

test('mobile presentation preserves bottom navigation and compacts the footer', () => {
  for (const label of ['Home', 'Categories', 'Wishlist', 'Cart', 'Account']) {
    assert.match(mobileNav, new RegExp(label, 'u'));
  }
  assert.match(homepageStyles, /padding-bottom: calc\(6rem \+ env\(safe-area-inset-bottom\)\)/u);
  assert.match(footerStyles, /\.zy-launch-footer-grid \{ grid-template-columns: repeat\(2/u);
  assert.match(footerStyles, /padding-block: 1\.65rem/u);
});

test('homepage remains the existing live-data flow with the preferred reference order', () => {
  const order = [
    'zy-foundation-hero-wrap',
    'zy-foundation-category-dock',
    '<HomepageTrustStrip />',
    'zy-home-category-promos',
    'zy-home-secondary-promos',
    "id: 'homepage-new-arrivals'",
    "id: 'homepage-featured-products'",
    "id: 'homepage-best-sellers'",
    "id: 'homepage-recommended-products'",
  ];
  const positions = order.map(marker => homepage.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
});
