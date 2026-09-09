import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const preview = readFileSync('src/services/storefront/homepagePreviewPresentation.ts', 'utf8');
const styles = readFileSync('src/styles/homepagePreview.css', 'utf8');
const trust = readFileSync('src/components/HomepageTrustStrip.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');

test('final reference pass keeps one preview hero headline and a single primary CTA', () => {
  assert.match(hero, /normalizeHeroPresentationText/);
  assert.match(hero, /REFERENCE_HERO_TITLE/);
  assert.match(hero, /HomepagePreviewProductArt art=\{product\.art\} tone=\{product\.tone\}/u);
  assert.match(styles, /\.zy-reference-preview \.zy-ai-hero-secondary \{\s*display: none/u);
});

test('all hero slide sources use one sanitized reference-led presentation contract', () => {
  assert.match(hero, /const configuredSlides = settings\?\.heroBanners/);
  assert.match(hero, /const cmsSlides = configuredSlides\.map/);
  assert.match(hero, /const slides = previewPresentation\?\.hero \? \[previewPresentation\.hero, \.\.\.cmsSlides\]/);
  assert.match(hero, /const displayBadge = normalizeHeroPresentationText/);
  assert.match(hero, /const displayTitle = normalizeHeroPresentationText/);
  assert.match(hero, /const displaySubtitle = normalizeHeroPresentationText/);
  assert.match(hero, /const displayCta = normalizeHeroPresentationText/);
  assert.doesNotMatch(hero, /['"]Special promotion in Colombo['"]|['"]Marketplace Collection['"]|['"]ORDER NOW['"]/iu);
  assert.match(hero, /\{displayBadge\}/);
  assert.match(hero, /\{displayTitle\}/);
  assert.match(hero, /\{displayCta(?:\s*\|\| 'Shop Now')?\}/);
});

test('Today\'s Offers keeps its handler without a false active navigation state', () => {
  assert.match(navbar, /id: 'today-offers',[\s\S]{0,160}action: navigateToDeals/);
  assert.match(navbar, /link\.id !== 'today-offers' && currentPage === link\.id/);
});

test('development preview uses one bounded six-card non-commerce showcase', () => {
  const shelfCounts = [...preview.matchAll(/shelf: '(deals|featured|new|best-seller|recommended)'/gu)]
    .reduce<Record<string, number>>((counts, match) => {
      counts[match[1]] = (counts[match[1]] || 0) + 1;
      return counts;
    }, {});
  assert.deepEqual(shelfCounts, { recommended: 6 });
  assert.doesNotMatch(preview, /collection visual|Mobile accessory visual|Audio collection visual/iu);
  assert.doesNotMatch(preview, /fake|mock|sample|discount|rating|stock/iu);
  assert.match(homepage, /<HomepagePreviewProductShelf/u);
  assert.match(homepage, /shelf.tone === 'recommended'/u);
  assert.match(preview, /import\.meta\.env\.DEV/u);
});

test('final responsive pass keeps reference proportions and safe navigation clearance', () => {
  assert.match(styles, /\.zy-reference-preview \.zy-ai-hero-stage\.is-reference-preview[\s\S]*height: 22rem !important/u);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*height: 20rem !important/u);
  assert.match(styles, /@media \(max-width: 389px\)[\s\S]*height: 18\.75rem !important/u);
  assert.match(styles, /\.zy-penpot-storefront \.zy-desktop-navigation nav button:last-child/u);
  assert.match(styles, /#floating-whatsapp-btn[\s\S]*z-index: 35 !important/u);
  assert.match(styles, /\.zy-penpot-storefront \.zy-l6-main[\s\S]*padding-bottom: calc\(6rem/u);
});

test('trust strip remains limited to the four verified customer claims', () => {
  for (const claim of ['Cash on Delivery', 'Islandwide Delivery', 'Secure Checkout', 'Customer Support']) {
    assert.match(trust, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.equal((trust.match(/title:/gu) || []).length, 4);
});
