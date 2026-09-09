import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice2Start = styles.indexOf('/* Homepage redesign Slice 2');
const slice3Start = styles.indexOf('/* Homepage redesign Slice 3');
const slice2Styles = styles.slice(slice2Start, slice3Start === -1 ? styles.length : slice3Start);

test('Slice 2 keeps the CMS-backed hero and existing carousel/CTA handlers', () => {
  assert.match(homepage, /<HeroBanner[\s\S]*settings=\{settings\}/);
  assert.match(hero, /settings\?\.heroBanners\?\.filter\(banner => banner\.enabled !== false\)/);
  assert.match(hero, /activeSlide\.image/);
  assert.match(hero, /onClick=\{handlePrevious\}/);
  assert.match(hero, /onClick=\{handleNext\}/);
  assert.match(hero, /onClick=\{handlePrimaryAction\}/);
  assert.match(hero, /onClick=\{onBrowseCategories \|\| onExploreProducts\}/);
  assert.match(hero, /MARKETPLACE_MESSAGE/);
});

test('Slice 2 applies the approved warm campaign composition only to the homepage hero', () => {
  assert.match(styles, /Slice 2: CMS-backed blue\/orange hero presentation/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-launch-home \.zy-ai-hero-stage[\s\S]*#ffd83d[\s\S]*#ff8a2b/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-launch-home \.zy-ai-hero-slide[\s\S]*grid-template-columns: minmax\(0, 1\.04fr\)/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-launch-home \.zy-ai-hero-copy h1[\s\S]*font-size: clamp\(2\.35rem/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-launch-home \.zy-ai-hero-primary[\s\S]*#2563eb/);
  assert.match(styles, /\.zy-penpot-storefront \.zy-launch-home \.zy-ai-hero-pagination[\s\S]*left: 50%/);
  assert.doesNotMatch(slice2Styles, /firebase|firestore|SupplierHub|supplierSync/iu);
});

test('Slice 2 covers tablet and narrow mobile hero safety without touching lower sections', () => {
  assert.match(styles, /@media \(max-width: 1023px\) and \(min-width: 768px\)/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /@media \(max-width: 389px\)/);
  assert.match(slice2Styles, /height: 21\.5rem !important/);
  assert.match(slice2Styles, /height: 20rem !important/);
  assert.match(slice2Styles, /zy-ai-hero-visual[\s\S]*pointer-events: none/);
  assert.doesNotMatch(slice2Styles, /zy-foundation-category-dock|zy-storefront-product-shelf|zy-mobile-dock/iu);
});
