import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { HeroBannerSettings } from '../src/types';
import {
  DEFAULT_HERO_FOCAL_POINT,
  HERO_IMAGE_CONTRACT,
  HERO_THEMES,
  compareHeroSlideOrder,
  createHeroSlide,
  isStructurallyValidHeroSlide,
  isValidHeroFocalPoint,
  normalizeHeroFocalPoint,
  resolveHeroArtwork,
  toHeroCampaignSlide,
  validateHeroSlide,
  withSequentialHeroSortOrder,
} from '../src/services/hero-slider/heroSlider';
import { LAUNCH_HERO_BANNERS, toLaunchHeroSlide } from '../src/services/storefront/launchMerchandising';

const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const editor = readFileSync('src/components/HeroSliderEditor.tsx', 'utf8');
const admin = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const styles = readFileSync('src/styles/launchMerchandising.css', 'utf8');

const legacyBanner = (overrides: Partial<HeroBannerSettings> = {}): HeroBannerSettings => ({
  id: 'legacy-1',
  badge: 'FEATURED',
  title: 'Legacy headline',
  subtitle: 'Legacy subtitle',
  description: '',
  image: 'https://cdn.example.test/legacy.jpg',
  bgGradient: 'from-black via-zinc-950/90 to-blue-950/20',
  buttonText: 'Shop Now',
  buttonUrl: '/products',
  enabled: true,
  ...overrides,
});

/** Mirrors the HeroBanner selection chain locked below. */
const selectSlides = (banners: HeroBannerSettings[]) => {
  const cmsSlides = banners
    .filter(banner => banner.enabled !== false)
    .map((banner, index) => toHeroCampaignSlide(banner, index))
    .filter(isStructurallyValidHeroSlide)
    .sort(compareHeroSlideOrder);
  return cmsSlides.length > 0 ? cmsSlides : LAUNCH_HERO_BANNERS.map(toLaunchHeroSlide);
};

test('hero selection chain in the component matches the tested precedence helpers', () => {
  assert.match(hero, /const configuredSlides = settings\?\.heroBanners\?\.filter\(banner => banner\.enabled !== false\) \|\| \[\];/);
  assert.match(hero, /configuredSlides\.map\(\(banner, index\) => toHeroCampaignSlide\(banner, index\)\)\s*\.filter\(isStructurallyValidHeroSlide\)\s*\.sort\(compareHeroSlideOrder\);/);
  assert.match(hero, /const liveSlides = cmsSlides\.length > 0 \? cmsSlides : launchSlides;/);
  assert.match(hero, /const launchSlides: readonly HeroCampaignSlide\[\] = LAUNCH_HERO_BANNERS\.map\(toLaunchHeroSlide\);/);
});

test('valid enabled CMS banners win; no valid banner falls back to the five launch slides', () => {
  assert.deepEqual(selectSlides([legacyBanner()]).map(slide => slide.id), ['legacy-1']);
  assert.deepEqual(
    selectSlides([legacyBanner({ enabled: false }), legacyBanner({ id: 'blank', title: '   ' })]).map(slide => slide.id),
    LAUNCH_HERO_BANNERS.map(banner => banner.id),
  );
  assert.equal(selectSlides([]).length, 5);
  assert.equal(selectSlides([legacyBanner({ title: 'Premium Electronics' })])[0].id, 'legacy-1');
});

test('enabled state and sortOrder control storefront order; missing sortOrder keeps array order', () => {
  const ordered = selectSlides([
    legacyBanner({ id: 'c', sortOrder: 2 }),
    legacyBanner({ id: 'a', sortOrder: 0 }),
    legacyBanner({ id: 'hidden', sortOrder: 1, enabled: false }),
    legacyBanner({ id: 'b', sortOrder: 1 }),
  ]);
  assert.deepEqual(ordered.map(slide => slide.id), ['a', 'b', 'c']);
  assert.deepEqual(selectSlides([legacyBanner({ id: 'x' }), legacyBanner({ id: 'y' })]).map(slide => slide.id), ['x', 'y']);
});

test('old CMS banners without the new fields load safely with sensible defaults', () => {
  const slide = toHeroCampaignSlide(legacyBanner(), 0);
  assert.equal(slide.mobileImage, '');
  assert.equal(slide.imageAlt, '');
  assert.equal(slide.focalPointDesktop, DEFAULT_HERO_FOCAL_POINT);
  assert.equal(slide.focalPointMobile, DEFAULT_HERO_FOCAL_POINT);
  assert.ok(HERO_THEMES.includes(slide.theme));
  assert.equal(slide.sortOrder, 0);
  assert.equal(toHeroCampaignSlide(legacyBanner({ bgGradient: 'from-black via-stone-950/90 to-orange-950/30' }), 0).theme, 'sunrise');
  assert.equal(toHeroCampaignSlide(legacyBanner({ theme: 'ocean' }), 0).theme, 'ocean');
  assert.equal(toHeroCampaignSlide(legacyBanner({ theme: 'neon' }), 1).theme, HERO_THEMES[1]);
  assert.equal(toHeroCampaignSlide(legacyBanner({ focalPointDesktop: '20% 40%' }), 0).focalPointMobile, '20% 40%');
  assert.equal(toHeroCampaignSlide(legacyBanner({ focalPointDesktop: 'left' }), 0).focalPointDesktop, DEFAULT_HERO_FOCAL_POINT);
  assert.deepEqual(toHeroCampaignSlide(legacyBanner({ buttonUrl: '/categories/automotive' }), 0).visualCategoryIds, ['automotive']);
});

test('mobile artwork is preferred on mobile and desktop artwork is the fallback', () => {
  assert.deepEqual(resolveHeroArtwork({ image: 'd.jpg', mobileImage: 'm.jpg' }), { desktop: 'd.jpg', mobile: 'm.jpg', hasArtwork: true });
  assert.deepEqual(resolveHeroArtwork({ image: 'd.jpg', mobileImage: '' }), { desktop: 'd.jpg', mobile: 'd.jpg', hasArtwork: true });
  assert.deepEqual(resolveHeroArtwork({ image: '', mobileImage: '' }), { desktop: '', mobile: '', hasArtwork: false });
  assert.match(hero, /<source\s+media="\(max-width: 767px\)"\s+srcSet=\{artwork\.mobile\}/);
  assert.match(hero, /src=\{artwork\.desktop\}/);
  assert.match(hero, /alt=\{stage\.imageAlt \|\| displayTitle\}/);
  assert.match(styles, /object-position: var\(--zy-ch-focal-mobile, var\(--zy-ch-focal-desktop, 70% 50%\)\)/);
  assert.deepEqual({ ...HERO_IMAGE_CONTRACT.desktop }, { width: 1600, height: 720 });
  assert.deepEqual({ ...HERO_IMAGE_CONTRACT.mobile }, { width: 1080, height: 960 });
});

test('launch fallback slides ship dedicated desktop and mobile artwork that spans the full slide', () => {
  const keys = ['main', 'electronics', 'automotive', 'fashion', 'delivery'];
  assert.deepEqual(LAUNCH_HERO_BANNERS.map(banner => banner.title), [
    'Upgrade Your Everyday',
    'Smart Tech for Everyday Life',
    'Drive Smarter',
    'Style for Every Day',
    'Easy Shopping Across Sri Lanka',
  ]);
  LAUNCH_HERO_BANNERS.forEach((banner, index) => {
    assert.equal(banner.desktopImage, `/launch/hero-${keys[index]}-desktop.png`);
    assert.equal(banner.mobileImage, `/launch/hero-${keys[index]}-mobile.png`);
    assert.ok(existsSync(`public${banner.desktopImage}`), banner.desktopImage);
    assert.ok(existsSync(`public${banner.mobileImage}`), banner.mobileImage);
    assert.equal(resolveHeroArtwork(toLaunchHeroSlide(banner, index)).hasArtwork, true);
  });
  assert.match(styles, /\.zy-campaign-hero-slide\[data-artwork='true'\] \.zy-campaign-hero-visual \{[^}]*inset: 0;[^}]*grid-column: 1 \/ -1;/);
});

test('settings race: a loading skeleton renders instead of fallback slides until settings resolve', () => {
  assert.match(app, /settingsLoading=\{settings === null && !settingsUnavailable\}/);
  assert.match(app, /setSettingsUnavailable\(true\);\s*handleDataFailure\('settings', error\);/);
  assert.match(homepage, /settingsLoading=\{settingsLoading\}/);
  assert.match(homepage, /productsLoading=\{loading\}/);
  assert.match(hero, /const isLoadingSettings = settingsLoading && !isReferencePreview;/);
  const loadingBranch = hero.slice(hero.indexOf('if (isLoadingSettings) {'), hero.indexOf('const slideStyle'));
  assert.match(loadingBranch, /aria-busy="true"/);
  assert.doesNotMatch(loadingBranch, /displayTitle|<h1|LAUNCH_HERO_BANNERS/);
  assert.match(hero, /!isLoadingSettings;/);
  assert.match(hero, /if \(!hasMultipleSlides \|\| isLoadingSettings\) return;\s*const next = slides\[/);
});

test('hero shows one CTA, no chips, no search and no secondary action', () => {
  assert.equal((hero.match(/className="zy-campaign-hero-cta"/g) || []).length, 1);
  assert.doesNotMatch(hero, /zy-ai-hero-popular|zy-ai-hero-secondary|zy-ai-hero-search|Explore Categories/);
  assert.match(hero, /const target = activeSlide\.ctaUrl;\s*const destination = resolveLaunchHeroTarget\(target\);/);
});

test('motion: crossfade, gentle zoom, text rise, paused autoplay and reduced-motion safety', () => {
  assert.match(hero, /<MotionConfig reducedMotion="user">/);
  assert.match(hero, /transition=\{\{ duration: 0\.6, ease: SLIDE_EASE \}\}/);
  assert.match(hero, /animate=\{shouldReduceMotion \? \{ scale: 1, x: 0 \} : \{ scale: 1\.045, x: -8 \}\}/);
  assert.match(hero, /initial=\{\{ opacity: 0, y: 12 \}\}/);
  assert.match(hero, /duration: 0\.45/);
  assert.match(hero, /const canAutoplay = isPlaying && hasMultipleSlides && !shouldReduceMotion && !isLoadingSettings;/);
  assert.match(hero, /window\.setTimeout\(/);
  assert.doesNotMatch(hero, /setInterval/);
  assert.match(hero, /onMouseEnter=\{\(\) => setIsPlaying\(false\)\}/);
  assert.match(hero, /onFocusCapture=\{\(\) => setIsPlaying\(false\)\}/);
  assert.match(hero, /key=\{activeSlide\.id\}/);
  assert.match(styles, /@keyframes zy-campaign-hero-copy-rise[\s\S]*opacity: 0;[\s\S]*transform: translateY\(var\(--zy-ch-copy-shift, 8px\)\)[\s\S]*opacity: 1;/);
  assert.match(styles, /@keyframes zy-campaign-hero-cta-rise[\s\S]*transform: translateY\(6px\) scale\(0\.98\)[\s\S]*transform: translateY\(0\) scale\(1\)/);
  assert.match(styles, /\.zy-campaign-hero-badge \{[\s\S]*animation: zy-campaign-hero-copy-rise 340ms[^;]*both;/);
  assert.match(styles, /\.zy-campaign-hero-copy h1 \{[\s\S]*--zy-ch-copy-shift: 12px;[\s\S]*animation: zy-campaign-hero-copy-rise 480ms[^;]*80ms both;/);
  assert.match(styles, /\.zy-campaign-hero-subtitle \{[\s\S]*animation: zy-campaign-hero-copy-rise 400ms[^;]*150ms both;/);
  assert.match(styles, /\.zy-campaign-hero-cta \{[\s\S]*animation: zy-campaign-hero-cta-rise 350ms[^;]*220ms both;/);
  assert.doesNotMatch(styles, /zy-campaign-hero-(?:copy|cta)-(?:rise|rise-cta)[^\n]*infinite/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
  assert.match(styles, /\.zy-campaign-hero-copy,\s*\.zy-campaign-hero-copy > \* \{[\s\S]*opacity: 1 !important;[\s\S]*transform: none !important;/);
});

test('campaign hero keeps legacy selectors out and stays aligned with the category grid', () => {
  assert.doesNotMatch(hero, /zy-ai-hero|zy-hero-v2/);
  assert.match(styles, /\.zy-campaign-hero \{[\s\S]*width: min\(100%, 80rem\);[\s\S]*margin-inline: auto;/);
  assert.match(styles, /height: clamp\(16rem, calc\(50vw \+ 4\.75rem\), 18\.125rem\);/);
  assert.match(styles, /@media \(max-width: 767px\) and \(min-width: 431px\)[\s\S]*height: clamp\(18\.125rem, calc\(8\.93vw \+ 15\.72rem\), 20rem\);/);
  assert.match(styles, /height: clamp\(20rem, calc\(25vw \+ 8rem\), 24rem\);/);
  assert.match(styles, /\.zy-campaign-hero-cta \{[\s\S]*?min-height: 2\.75rem;/);
});

test('homepage flow removes generic deal filler and prioritizes real product shelves', () => {
  assert.doesNotMatch(homepage, /import HomepageTrustStrip from/);
  assert.doesNotMatch(homepage, /<HomepageTrustStrip\s*\/>/);
  const dealIndex = homepage.indexOf('renderShelf(flashDealsShelf)');
  const newArrivalsIndex = homepage.indexOf('renderShelf(newArrivalsShelf)');
  const secondaryIndex = homepage.indexOf('{secondaryPromoItems.length > 0');
  assert.ok(Math.min(dealIndex, newArrivalsIndex) < secondaryIndex);
  assert.match(homepage, /const hasLiveDeals = homepageSections\.flashDeals\.enabled && discountedProducts\.length > 0/);
  assert.match(homepage, /renderShelf\(flashDealsShelf\)/);
  assert.match(homepage, /renderShelf\(newArrivalsShelf\)/);
  assert.match(homepage, /hasLiveDeals && homepageSections\.newArrivals\.enabled && renderShelf\(newArrivalsShelf\)/);
  assert.doesNotMatch(homepage, /HomepageDealStrip|Shop Today['’]s Picks|Featured picks/);
});

test('admin editor: sequential sortOrder, new fields and backward-compatible payload', () => {
  const slides = withSequentialHeroSortOrder([legacyBanner({ id: 'b' }), legacyBanner({ id: 'a', sortOrder: 9 })]);
  assert.deepEqual(slides.map(slide => [slide.id, slide.sortOrder]), [['b', 0], ['a', 1]]);
  assert.equal(slides[0].bgGradient, legacyBanner().bgGradient);
  const created = createHeroSlide('new');
  assert.equal(created.theme, 'zyro');
  assert.equal(created.mobileImage, '');
  assert.equal(created.focalPointDesktop, DEFAULT_HERO_FOCAL_POINT);
  assert.ok(Object.values(created).every(value => value !== undefined));
  assert.match(editor, /withSequentialHeroSortOrder\(updater\(current\.heroBanners\)\)/);
  assert.match(editor, /onImageUpload\(event, banner\.id, field\)/);
  assert.match(editor, /Recommended \{size\.width\} × \{size\.height\}px/);
  assert.match(editor, /HERO_THEMES\.map/);
  assert.match(editor, /HERO_FOCAL_POINT_PRESETS\.map/);
  assert.match(editor, /updateSlide\(banner\.id, \{ theme: event\.target\.value \}\)/);
});

test('admin upload keeps the existing validated banners/ Storage path for both artwork fields', () => {
  const upload = admin.slice(admin.indexOf('const handleBannerImageUpload'), admin.indexOf('const handleLogoUpload'));
  assert.match(upload, /field: 'image' \| 'mobileImage' = 'image'/);
  assert.match(upload, /storageRef\(storage, `banners\/\$\{fileName\}`\)/);
  assert.match(upload, /file\.size > 5 \* 1024 \* 1024/);
  assert.match(upload, /\{ \.\.\.b, \[field\]: downloadUrl \}/);
});

test('validation covers the new optional fields without breaking legacy banners', () => {
  assert.deepEqual(validateHeroSlide(legacyBanner()), []);
  assert.deepEqual(validateHeroSlide(legacyBanner({ theme: '' })), []);
  assert.deepEqual(validateHeroSlide(legacyBanner({ theme: 'neon' })).map(error => error.field), ['theme']);
  assert.deepEqual(validateHeroSlide(legacyBanner({ mobileImage: 'javascript:alert(1)' })).map(error => error.field), ['mobileImage']);
  assert.deepEqual(validateHeroSlide(legacyBanner({ focalPointMobile: '150% 20%' })).map(error => error.field), ['focalPointMobile']);
  assert.equal(isValidHeroFocalPoint('0% 100%'), true);
  assert.equal(isValidHeroFocalPoint('center'), false);
  assert.equal(normalizeHeroFocalPoint(' 30% 50% '), '30% 50%');
});
