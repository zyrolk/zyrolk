import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice5Styles = styles.slice(
  styles.indexOf('/* Homepage redesign Slice 5'),
  styles.indexOf('/* Homepage redesign Slice 6'),
);

test('Slice 5 keeps live category cards first and fills only local preview density gaps', () => {
  assert.match(homepage, /const promoCategoryItems: HomepagePromoItem\[\] = \[/);
  assert.match(homepage, /const FEATURED_CATEGORY_CARD_LIMIT = 4;/);
  assert.match(homepage, /categoryCardVisuals\.slice\(0, FEATURED_CATEGORY_CARD_LIMIT\)/);
  assert.match(homepage, /orderByCategoryPriority\(categoryVisuals, item => item\.category\.id, LAUNCH_FEATURED_CATEGORY_IDS\)/);
  assert.match(homepage, /item\.image && !bannerCategoryIds\.has\(item\.category\.id\)/);
  assert.ok(homepage.indexOf('const bannerCategoryIds') < homepage.indexOf('const categoryCardVisuals'));
  assert.match(homepage, /item\.onClick/);
  assert.match(homepage, /item\.image/);
  assert.match(homepage, /previewPresentation\?\.promos/);
  assert.doesNotMatch(homepage, /itemsCount.*(?:product|products) available/);
  assert.doesNotMatch(homepage, /up to \d+%|limited[- ]time|save \d+|fake|mock|sample|urgent/iu);
});

test('Slice 5 keeps the row before the new deal strip and existing lower homepage content', () => {
  assert.doesNotMatch(homepage, /<HomepageTrustStrip\s*\/>/);
  const firstShelf = Math.min(homepage.indexOf('renderShelf(flashDealsShelf)'), homepage.indexOf('renderShelf(newArrivalsShelf)'));
  assert.ok(homepage.indexOf('zy-home-category-promos') < firstShelf);
  assert.ok(firstShelf < homepage.indexOf('zy-home-secondary-promos'));
  assert.match(homepage, /zy-home-category-promos-header/);
  assert.match(homepage, /zy-home-category-promo-cta/);
});

test('Slice 5 provides a four-tone desktop row and compact two-column mobile cards only', () => {
  assert.match(styles, /Slice 5: live promotional category cards/);
  assert.match(slice5Styles, /zy-home-category-promo-grid[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(slice5Styles, /@media \(max-width: 1023px\) and \(min-width: 768px\)[\s\S]*zy-home-category-promo-grid[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(slice5Styles, /zy-home-category-promo-copy \{[\s\S]*?width: 64%;/);
  assert.match(slice5Styles, /zy-home-category-promo-media \{[\s\S]*?position: absolute;/);
  assert.match(slice5Styles, /zy-home-category-promo-tone-0[\s\S]*linear-gradient/);
  assert.match(slice5Styles, /zy-home-category-promo-tone-1[\s\S]*linear-gradient/);
  assert.match(slice5Styles, /zy-home-category-promo-tone-2[\s\S]*linear-gradient/);
  assert.match(slice5Styles, /zy-home-category-promo-tone-3[\s\S]*linear-gradient/);
  assert.match(slice5Styles, /zy-home-category-promo-media[\s\S]*object-fit: contain/);
  assert.match(slice5Styles, /@media \(max-width: 767px\)[\s\S]*zy-home-category-promo-grid[\s\S]*grid-template-columns: repeat\(2/);
  assert.doesNotMatch(slice5Styles, /zy-ai-hero|zy-foundation-category|zy-launch-trust|zy-storefront-product-shelf|zy-launch-footer|zy-mobile-dock/iu);
});
