import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const whyChoose = readFileSync('src/components/HomepageWhyChoose.tsx', 'utf8');
const reviews = readFileSync('src/components/HomepageCustomerReviews.tsx', 'utf8');
const footer = readFileSync('src/components/Footer.tsx', 'utf8');
const productCard = readFileSync('src/components/ProductCard.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('Sprint 75B composes Why Choose below trust and reviews after live product shelves', () => {
  assert.match(homepage, /import HomepageWhyChoose from '\.\/HomepageWhyChoose'/);
  assert.match(homepage, /import HomepageCustomerReviews/);
  assert.ok(homepage.indexOf('<HomepageTrustStrip />') < homepage.indexOf('<HomepageWhyChoose />'));
  assert.ok(homepage.indexOf('<HomepageWhyChoose />') < homepage.indexOf('<StorefrontProductShelf'));
  assert.ok(homepage.lastIndexOf('<StorefrontProductShelf') < homepage.indexOf('<HomepageCustomerReviews'));
  assert.match(homepage, /enabled=\{settings\?\.enableReviews !== false\}/);
});

test('homepage reviews reuse the existing live approved-review snapshot', () => {
  assert.match(app, /const \[homepageReviews, setHomepageReviews\] = useState/);
  assert.match(app, /onSnapshot\(collection\(db, "reviews"\)/);
  assert.match(app, /if \(d\.approved !== false\)/);
  assert.match(app, /setHomepageReviews\(revList\)/);
  assert.match(app, /reviews=\{homepageReviews\}/);
  assert.match(homepage, /reviews=\{reviews\}/);
  assert.doesNotMatch(reviews, /firebase|firestore|collection\(|onSnapshot\(/iu);
});

test('customer review presentation validates live content and provides honest empty states', () => {
  assert.match(reviews, /review\.approved !== false/);
  assert.match(reviews, /Number\.isFinite\(Number\(review\.rating\)\)/);
  assert.match(reviews, /\.slice\(0, 6\)/);
  assert.match(reviews, /productNames\.get\(review\.productId\)/);
  assert.match(reviews, /Customer stories will appear here/);
  assert.match(reviews, /Customer reviews are currently unavailable/);
  assert.match(reviews, /Published marketplace reviews will be shown automatically/);
  assert.doesNotMatch(reviews, /mock|sample review|verified purchase|verified buyer/iu);
});

test('Why Choose messaging reflects existing storefront capabilities without invented data', () => {
  for (const message of [
    'A live marketplace catalogue',
    'Discovery made simple',
    'Clear ordering',
    'Built for Sri Lanka',
  ]) {
    assert.match(whyChoose, new RegExp(message));
  }
  assert.doesNotMatch(whyChoose, /firebase|firestore|mock|warranty|guarantee/iu);
});

test('premium footer preserves store settings, social links, categories, and destinations', () => {
  for (const setting of [
    'footerLogoUrl',
    'logoUrl',
    'storeName',
    'aboutText',
    'copyrightText',
    'facebookUrl',
    'instagramUrl',
    'tiktokUrl',
    'youtubeUrl',
    'contactAddress',
    'contactPhone',
    'contactPhone2',
    'contactEmail',
  ]) {
    assert.match(footer, new RegExp(`settings\\??\\.${setting}`));
  }
  assert.match(footer, /categoryCounts\[category\.id\]/);
  assert.match(footer, /handleCategoryClick\(category\.id\)/);
  for (const destination of ['home', 'products', 'categories', 'wishlist', 'contact', 'about-us', 'faq', 'return-policy', 'terms-conditions', 'privacy-policy']) {
    assert.match(footer, new RegExp(`['"]${destination}['"]`));
  }
});

test('Sprint 75B styles are premium, responsive, mobile-scrollable, and motion-safe', () => {
  assert.match(styles, /Sprint 75B — Homepage launch polish/);
  assert.match(styles, /\.zy-launch-why-grid\s*\{[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(styles, /\.zy-launch-reviews-shell\s*\{[\s\S]*grid-template-columns:/);
  assert.match(styles, /\.zy-launch-footer-grid\s*\{[\s\S]*grid-template-columns:/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.zy-launch-reviews-grid[\s\S]*scroll-snap-type: x mandatory/);
  assert.match(styles, /@media \(max-width: 389px\)[\s\S]*\.zy-launch-why-grid \{ grid-template-columns: 1fr/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.zy-launch-why,[\s\S]*\.zy-launch-reviews \{ animation: none/);
});

test('Sprint 75B does not duplicate or replace the shared ProductCard contract', () => {
  assert.doesNotMatch(whyChoose, /ProductCard/);
  assert.doesNotMatch(reviews, /ProductCard/);
  assert.doesNotMatch(footer, /ProductCard/);
  assert.match(productCard, /onAddToCart/);
  assert.match(productCard, /onToggleWishlist/);
  assert.match(productCard, /onViewDetail/);
});
