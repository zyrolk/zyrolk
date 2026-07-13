import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHeroSlide,
  duplicateHeroSlide,
  isSafeHeroUrl,
  normalizeSlideSpeed,
  validateHeroSlide,
  validateHeroSlides,
} from '../src/services/hero-slider/heroSlider';

test('legacy slides remain valid without newly optional fields', () => {
  const errors = validateHeroSlide({
    id: 'legacy', badge: 'Offer', title: 'Legacy', subtitle: '', description: '', image: 'https://example.com/hero.jpg',
  });
  assert.deepEqual(errors, []);
});

test('slide validation requires content and safe CTA URLs', () => {
  const slide = createHeroSlide('slide');
  slide.title = '';
  slide.image = '';
  slide.buttonUrl = 'javascript:alert(1)';
  assert.deepEqual(validateHeroSlide(slide).map((error) => error.field), ['title', 'image', 'buttonUrl']);
  assert.equal(isSafeHeroUrl('/products'), true);
  assert.equal(isSafeHeroUrl('https://zyro.lk/products'), true);
  assert.equal(isSafeHeroUrl('//evil.example'), false);
});

test('CTA label uses the storefront default when CTA URL is empty', () => {
  const slide = createHeroSlide('cta-default');
  slide.buttonText = 'Shop the offer';
  slide.buttonUrl = '   ';
  assert.deepEqual(validateHeroSlide(slide).filter((error) => error.field === 'buttonUrl'), []);
});

test('CTA URL is ignored when the CTA label is not used', () => {
  const slide = createHeroSlide('cta-unused');
  slide.buttonText = '   ';
  slide.buttonUrl = 'javascript:legacy-value';
  assert.equal(validateHeroSlide(slide).some((error) => error.field === 'buttonUrl'), false);
});

test('duplicate creates an independent slide with a new ID', () => {
  const source = createHeroSlide('source');
  const copy = duplicateHeroSlide(source, 'copy');
  assert.equal(copy.id, 'copy');
  assert.equal(copy.title, `${source.title} (Copy)`);
  assert.notEqual(copy, source);
});

test('collection validation detects duplicate IDs', () => {
  assert.equal(validateHeroSlides([createHeroSlide('same'), createHeroSlide('same')]).some((error) => error.field === 'slides'), true);
});

test('slide speed is normalized to supported seconds', () => {
  assert.equal(normalizeSlideSpeed(undefined), 6);
  assert.equal(normalizeSlideSpeed(0), 2);
  assert.equal(normalizeSlideSpeed(60), 30);
  assert.equal(normalizeSlideSpeed(8), 8);
});
