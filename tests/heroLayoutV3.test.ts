import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('Hero V3 uses one continuous CMS background with an overlaid content gradient', () => {
  assert.match(styles, /\.zy-hero-v2-image\s*\{[\s\S]*object-fit: contain/);
  assert.match(styles, /\.zy-hero-v2-image\s*\{[\s\S]*linear-gradient\(135deg, #172554, #1e3a8a 54%, #2563eb\)/);
  assert.match(styles, /\.zy-hero-v2-slide\s*\{[\s\S]*display: block/);
  assert.match(styles, /\.zy-hero-v2-copy\s*\{[\s\S]*position: relative;[\s\S]*z-index: 3;[\s\S]*background: transparent/);
  assert.match(styles, /\.zy-hero-v2-copy::before\s*\{[\s\S]*linear-gradient\(90deg,[\s\S]*transparent 100%\)/);
  assert.match(styles, /\.zy-hero-v2-visual\s*\{\s*position: absolute;\s*z-index: 0;\s*inset: 0/);
  assert.match(styles, /@media \(min-width: 640px\)[\s\S]*\.zy-hero-v2-copy \{ width: 56%; \}/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*\.zy-hero-v2-copy \{ width: 44%; \}/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*\.zy-hero-v2-stage \{ height: 35rem/);
  assert.match(styles, /\.zy-hero-v2-copy-inner\s*\{[\s\S]*justify-content: center/);
  assert.doesNotMatch(styles.match(/\.zy-hero-v2-image\s*\{[\s\S]*?\}/)?.[0] || '', /object-fit: cover/);
});

test('Hero V3 preserves CMS ordering, slider timing, gestures, arrows, and CTA destinations', () => {
  assert.match(hero, /settings\?\.heroBanners\?\.filter\(banner => banner\.enabled !== false\)/);
  assert.match(hero, /configuredSlides\.map\(\(banner, index\)/);
  assert.match(hero, /normalizeSlideSpeed\(settings\?\.autoSlideSpeed\)/);
  assert.match(hero, /settings\?\.enableSlider !== false/);
  assert.match(hero, /onTouchStart=\{handleTouchStart\}/);
  assert.match(hero, /onTouchEnd=\{handleTouchEnd\}/);
  assert.match(hero, /onClick=\{handlePrevious\}/);
  assert.match(hero, /onClick=\{handleNext\}/);
  assert.match(hero, /const target = activeSlide\.ctaUrl/);
  assert.match(hero, /onClick=\{handlePrimaryAction\}/);
  assert.match(hero, /onClick=\{onBrowseCategories \|\| onExploreProducts\}/);
});
