import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/storefrontHero.css', 'utf8');

test('premium hero communicates the marketplace without fabricated intelligence or commerce data', () => {
  assert.match(hero, /Sri Lankan Marketplace/);
  assert.match(hero, /Shop Smarter\./);
  assert.match(hero, /Discover Better\./);
  assert.match(hero, /trusted Sri Lankan suppliers with fast catalogue search/);
  assert.doesNotMatch(hero, /AI-Powered Marketplace|AI-assisted search/);
  assert.doesNotMatch(hero, /\b(?:1,000,000|five-star reviews|number one marketplace|guaranteed savings)\b/iu);
});

test('hero search reuses the customer-safe search projection and storefront navigation', () => {
  assert.match(hero, /projectCustomerProducts\(liveProducts\)/);
  assert.match(hero, /searchCustomerProducts\(customerProducts, debouncedQuery\)/);
  assert.match(hero, /What are you looking for today\?/);
  assert.match(hero, /onViewProduct\(product\)/);
  assert.match(hero, /onSelectCategory\(category\.id\)/);
  assert.match(homepage, /onSearch=\{onSearch\}/);
  assert.match(app, /onSearch=\{\(query\) => \{ setSearchQuery\(query\); setSelectedCategory\('all'\); setCurrentPage\('products'\); \}\}/);
});

test('hero keeps CMS campaign configuration and never introduces mock catalogue content', () => {
  assert.match(hero, /settings\?\.heroBanners/);
  assert.match(hero, /activeSlide\.image/);
  assert.match(hero, /activeSlide\.ctaUrl/);
  assert.match(hero, /normalizeSlideSpeed\(settings\?\.autoSlideSpeed\)/);
  assert.match(hero, /products\.filter\(product => product\.isActive !== false\)/);
  assert.match(hero, /\.filter\(category => category\.isActive !== false\)/);
  assert.doesNotMatch(hero, /mockProducts|sampleProducts|placeholderProducts/);
});

test('voice and image-search controls are honest and accessible', () => {
  assert.doesNotMatch(hero, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(hero, /disabled[\s\S]*aria-label="Voice search is unavailable in this launch version"/);
  assert.match(hero, /disabled[\s\S]*aria-label="Image search is coming soon"/);
  assert.match(hero, /role="search"/);
  assert.match(hero, /aria-autocomplete="list"/);
  assert.match(hero, /aria-activedescendant/);
  assert.match(hero, /event\.key === 'ArrowDown'/);
  assert.match(hero, /event\.key === 'Escape'/);
});

test('hero trust and category surfaces use factual labels and live category actions', () => {
  for (const label of [
    'Verified Suppliers',
    'Islandwide Delivery',
    'Secure Checkout',
    'Easy Returns',
    'Customer Support',
    'Relevant Recommendations',
  ]) {
    assert.match(hero, new RegExp(label));
  }
  assert.doesNotMatch(hero, /24\/7 Support/);
  assert.match(hero, /popularCategories\.map/);
  assert.match(hero, /visualCategories\.map/);
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
