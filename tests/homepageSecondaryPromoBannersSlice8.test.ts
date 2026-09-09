import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice8Styles = styles.slice(
  styles.indexOf('/* Homepage redesign Slice 8'),
  styles.indexOf('/* Homepage redesign Slice 10'),
);

test('Slice 8 keeps live secondary banners first and fills only local preview density gaps', () => {
  assert.match(homepage, /const secondaryPromoItems: HomepageBannerItem\[\] = \[/);
  assert.match(homepage, /categoryVisuals\.slice\(0, 2\)/);
  assert.match(homepage, /item\.onClick/);
  assert.match(homepage, /item\.image/);
  assert.match(homepage, /previewPresentation\?\.banners/);
  assert.match(homepage, /data-preview-banner-id/);
  assert.doesNotMatch(homepage, /up to \d+%|limited[- ]time|save \d+|fake|mock|sample|urgent/iu);
});

test('Slice 8 sits before the product discovery shelves in the reference-led flow', () => {
  assert.ok(homepage.indexOf('zy-home-secondary-promos') < homepage.indexOf("id: 'homepage-new-arrivals'"));
  assert.ok(homepage.indexOf("id: 'homepage-new-arrivals'") < homepage.indexOf("id: 'homepage-featured-products'"));
  assert.ok(homepage.indexOf("id: 'homepage-featured-products'") < homepage.indexOf("id: 'homepage-best-sellers'"));
  assert.ok(homepage.indexOf('zy-home-secondary-promos') < homepage.indexOf("id: 'homepage-recommended-products'"));
  assert.match(homepage, /aria-label="Explore more categories"/);
  assert.match(homepage, /Discover more/);
  assert.match(homepage, /Shop now/);
});

test('Slice 8 provides warm/cool wide banners and a compact stacked mobile layout', () => {
  assert.match(styles, /Slice 8: compact secondary category banners/);
  assert.match(slice8Styles, /zy-home-secondary-promo-grid[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(slice8Styles, /zy-home-secondary-promo-tone-0[\s\S]*linear-gradient\(118deg, #f97316/);
  assert.match(slice8Styles, /zy-home-secondary-promo-tone-1[\s\S]*linear-gradient\(118deg, #2563eb/);
  assert.match(slice8Styles, /zy-home-secondary-promo-media img[\s\S]*object-fit: contain/);
  assert.match(slice8Styles, /@media \(max-width: 767px\)[\s\S]*zy-home-secondary-promo-grid[\s\S]*grid-template-columns: 1fr/);
  assert.match(slice8Styles, /@media \(max-width: 389px\)/);
  assert.doesNotMatch(slice8Styles, /zy-storefront-product-shelf|zy-product-card|is-deals|is-featured|is-new|is-best-seller|is-recommended/);
});
