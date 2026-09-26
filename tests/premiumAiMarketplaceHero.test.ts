import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontHero.css', 'utf8');

test('premium hero communicates the marketplace without fabricated intelligence or commerce data', () => {
  assert.match(hero, /Sri Lankan marketplace/);
  assert.match(hero, /REFERENCE_HERO_TITLE/);
  assert.match(hero, /pay with Cash on Delivery when your order arrives/);
  assert.doesNotMatch(hero, /AI-Powered Marketplace|AI-assisted search/);
  assert.doesNotMatch(hero, /\b(?:1,000,000|five-star reviews|number one marketplace|guaranteed savings)\b/iu);
});

test('campaign hero leaves search to the header and keeps storefront navigation', () => {
  assert.doesNotMatch(hero, /role="search"|searchCustomerProducts|What are you looking for today\?/);
  assert.match(hero, /onViewProduct\(product\)/);
  assert.match(hero, /onSelectCategory\(destination\.categoryId\)/);
  assert.match(homepage, /onSearch=\{onSearch\}/);
  assert.match(app, /onSearch=\{\(query\) => \{ setSearchQuery\(query\); setSelectedCategory\('all'\); setCurrentPage\('products'\); \}\}/);
});

test('hero keeps CMS campaign configuration and never introduces mock catalogue content', () => {
  assert.match(hero, /settings\?\.heroBanners/);
  assert.match(hero, /activeSlide\.image/);
  assert.match(hero, /activeSlide\.ctaUrl/);
  assert.match(hero, /normalizeSlideSpeed\(settings\?\.autoSlideSpeed\)/);
  assert.match(hero, /products\.filter\(product => isProductExplicitlyActive\(product\.isActive\)\)/);
  assert.doesNotMatch(hero, /mockProducts|sampleProducts|placeholderProducts/);
});

test('voice and image-search controls stay hidden and the carousel is keyboard accessible', () => {
  assert.doesNotMatch(hero, /SpeechRecognition|webkitSpeechRecognition/);
  assert.doesNotMatch(hero, /Voice search is unavailable in this launch version/);
  assert.doesNotMatch(hero, /Image search is coming soon/);
  assert.doesNotMatch(hero, /<Mic\b/);
  assert.doesNotMatch(hero, /<Camera\b/);
  assert.match(hero, /aria-roledescription="carousel"/);
  assert.match(hero, /event\.key === 'ArrowLeft'/);
  assert.match(hero, /event\.key === 'ArrowRight'/);
});

test('hero has no trust cards or category chips; those live in the trust strip and category rail', () => {
  assert.doesNotMatch(hero, /zy-ai-hero-trust|Verified Suppliers/);
  assert.doesNotMatch(hero, /24\/7 Support|Relevant Recommendations|Easy Returns/);
  assert.doesNotMatch(hero, /popularCategories|visualCategories|Popular categories/);
});

test('isolated hero styling is responsive, touch-safe, and reduced-motion aware', () => {
  assert.match(styles, /\.zy-ai-hero-stage/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1\.06fr\)/);
  assert.match(styles, /min-height: 4\.15rem/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /@media \(max-width: 370px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.zy-ai-hero button:focus-visible/);
});
