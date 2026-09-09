import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const previewCard = readFileSync('src/components/HomepagePreviewProductCard.tsx', 'utf8');
const previewShelf = readFileSync('src/components/HomepagePreviewProductShelf.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const previewConfig = readFileSync('src/services/storefront/homepagePreviewPresentation.ts', 'utf8');

test('reference preview presentation is a single typed, reserved-namespace configuration', () => {
  const ids = [...previewConfig.matchAll(/id: '(preview:[^']+)'/g)].map(match => match[1]);
  assert.ok(ids.length >= 20);
  assert.ok(ids.every(id => id.startsWith('preview:')));
  assert.match(previewConfig, /const DEV_PREVIEW_PRESENTATION: HomepagePreviewPresentation/);
  assert.match(previewConfig, /import\.meta\.env\.DEV\s*\?\s*DEV_PREVIEW_PRESENTATION/);
  assert.match(previewConfig, /return enabled \? DEV_PREVIEW_PRESENTATION : null/);
});

test('production mode has no preview presentation and live products stay authoritative', () => {
  assert.match(previewConfig, /export const HOMEPAGE_PREVIEW_PRESENTATION: HomepagePreviewPresentation \| null/);
  assert.match(previewConfig, /export function isHomepagePreviewEnabled\(\): boolean/);
  assert.match(homepage, /const \[previewPresentation, setPreviewPresentation\] = useState/);
  assert.match(homepage, /if \(!import\.meta\.env\.DEV\) return/);
  assert.match(homepage, /import\('\.\.\/services\/storefront\/homepagePreviewPresentation'\)/);
  assert.match(homepage, /if \(loading \|\| hasLiveProducts\)/);
  assert.match(homepage, /if \(!shouldShowPreviewShelf \|\| !previewPresentation\) return null/);
  assert.match(homepage, /<StorefrontProductShelf/);
  assert.match(homepage, /products: discountedProducts/);
  assert.match(homepage, /products: featuredProducts/);
  assert.match(homepage, /products: recommendedProducts/);
  assert.match(hero, /previewPresentation\?\.hero/);
  assert.match(hero, /onClick=\{onBrowseCategories \|\| onExploreProducts\}/);
});

test('preview visual cards cannot enter commerce or persistence paths', () => {
  assert.doesNotMatch(previewCard, /from ['"]\.\/ProductCard['"]|Cart|Wishlist|Checkout|Firestore|setDoc|addDoc|updateDoc|onAddToCart|onToggleWishlist|onViewDetail/iu);
  assert.doesNotMatch(previewShelf, /from ['"]\.\/ProductCard['"]|onAddToCart|onToggleWishlist|onViewDetail|Firestore|setDoc|addDoc|updateDoc/iu);
  assert.match(previewCard, /data-preview-product-id=\{product\.id\}/);
  assert.match(homepage, /data-preview-promo-id/);
  assert.match(homepage, /data-preview-banner-id/);
  assert.match(homepage, /data-preview-category-id/);
  assert.doesNotMatch(previewCard, />Preview<|presentation preview only|Presentation preview/iu);
  assert.doesNotMatch(homepage, /presentation preview only/iu);
});

test('active homepage removes unsupported reference-only surfaces', () => {
  assert.doesNotMatch(navbar, /id: ['"]brands['"]/i);
  assert.doesNotMatch(homepage, /<HomepageWhyChoose/);
  assert.match(homepage, /reviews\.length > 0/);
  assert.match(homepage, /onBrowseCategories/);
});
