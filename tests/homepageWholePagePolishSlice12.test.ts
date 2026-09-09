import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice12Styles = styles.slice(styles.indexOf('/* Homepage redesign Slice 12'));

test('Slice 12 keeps the reference-led homepage order without changing product projections', () => {
  const order = [
    'zy-foundation-hero-wrap',
    'phase-one-categories-title',
    '<HomepageTrustStrip />',
    'zy-home-category-promos',
    "id: 'homepage-flash-deals'",
    'zy-home-secondary-promos',
    "id: 'homepage-new-arrivals'",
    "id: 'homepage-featured-products'",
    "id: 'homepage-best-sellers'",
    "id: 'homepage-recommended-products'",
    '<HomepageCustomerReviews',
  ];

  const positions = order.map(marker => homepage.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.match(homepage, /const recommendedShelfTitle = homepageSections\.recommended\.title === 'Recommended Products'\s+\? 'Explore More'/);
  assert.match(homepage, /title: recommendedShelfTitle/);
  assert.match(homepage, /title: 'More products are being refreshed'/);
});

test('Slice 12 aligns the active homepage to one scoped width and compact rhythm', () => {
  assert.match(styles, /Slice 12: final whole-homepage rhythm and alignment polish/);
  assert.match(slice12Styles, /--zy-final-home-width: 80rem/);
  assert.match(slice12Styles, /zy-foundation-category-dock[\s\S]*zy-foundation-container[\s\S]*zy-home-category-promos/);
  assert.match(slice12Styles, /zy-foundation-shelf-stack[\s\S]*gap: clamp/);
  assert.match(slice12Styles, /@media \(max-width: 767px\)[\s\S]*zy-foundation-shelf-stack[\s\S]*gap: 0\.8rem/);
  assert.match(slice12Styles, /@media \(max-width: 389px\)[\s\S]*gap: 0\.7rem/);
  assert.match(slice12Styles, /overflow-x: clip/);
  assert.doesNotMatch(slice12Styles, /firebase|supplier|checkout|marketPrice|comparePrice|discount|ProductCard/i);
});

test('Slice 12 keeps the existing customer-facing claims and data boundaries', () => {
  assert.doesNotMatch(homepage, /up to \d+%|limited[- ]time|save \d+|fake|mock|sample|secure payments|card payments|PayHere/iu);
  assert.match(homepage, /onSelectCategory\(category\.id\)/);
  assert.match(homepage, /onClick: onExploreProducts/);
  assert.match(homepage, /products: discountedProducts/);
  assert.match(homepage, /products: featuredProducts/);
  assert.match(homepage, /products: recommendedProducts/);
});
