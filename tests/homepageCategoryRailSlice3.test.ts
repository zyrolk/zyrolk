import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');
const slice3Start = styles.indexOf('/* Homepage redesign Slice 3');
const slice4Start = styles.indexOf('/* Homepage redesign Slice 4');
const slice3Styles = styles.slice(slice3Start, slice4Start === -1 ? styles.length : slice4Start);

test('Slice 3 keeps live category data, routes, and the working All Categories action', () => {
  assert.match(app, /getActiveCategories\(sortCategoriesAlphabetically\(catList\)\)/);
  assert.match(app, /const homepageCategories = useMemo\(\(\) => categories\.flatMap/);
  assert.match(homepage, /categoryVisuals\.map/);
  assert.match(homepage, /onClick: \(\) => onSelectCategory\(category\.id\)/);
  assert.match(homepage, /onClick=\{onBrowseCategories\}/);
  assert.match(homepage, /aria-label="Browse all categories"/);
});

test('Slice 3 uses a compact circular shortcut rail rather than category cards', () => {
  assert.match(styles, /Slice 3: live circular category rail/);
  assert.match(slice3Styles, /zy-foundation-category-rail[\s\S]*display: flex[\s\S]*overflow-x: auto/);
  assert.match(slice3Styles, /zy-foundation-category-image[\s\S]*border-radius: 50%/);
  assert.match(slice3Styles, /zy-foundation-category-tile small[\s\S]*display: none/);
  assert.match(slice3Styles, /zy-foundation-category-all \.zy-foundation-category-image[\s\S]*#2563eb/);
});

test('Slice 3 covers narrow mobile touch and overflow safety without changing other sections', () => {
  assert.match(slice3Styles, /@media \(max-width: 767px\)/);
  assert.match(slice3Styles, /@media \(max-width: 389px\)/);
  assert.match(slice3Styles, /flex: 0 0 4\.8rem/);
  assert.match(slice3Styles, /min-width: 0/);
  assert.doesNotMatch(slice3Styles, /zy-ai-hero|zy-storefront-product-shelf|zy-launch-trust|zy-mobile-dock/iu);
});
