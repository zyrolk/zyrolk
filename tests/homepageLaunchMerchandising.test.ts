import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Product } from '../src/types';
import {
  LAUNCH_CATEGORY_BANNERS,
  LAUNCH_FEATURED_CATEGORY_IDS,
  LAUNCH_HERO_BANNERS,
  LAUNCH_MERCHANDISING_IMAGE_CONTRACT,
  formatCategoryDisplayName,
  getCategoryMonogram,
  getLaunchCategoryArtwork,
  orderByCategoryPriority,
  pickLaunchHeroProducts,
  resolveLaunchHeroTarget,
} from '../src/services/storefront/launchMerchandising';
import { isStructurallyValidHeroSlide } from '../src/services/hero-slider/heroSlider';

const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const launchStyles = readFileSync('src/styles/launchMerchandising.css', 'utf8');

const product = (id: string, category: string, imageUrl = `https://example.test/${id}.jpg`) =>
  ({ id, name: id, category, imageUrl }) as unknown as Product;

test('launch hero config has the five approved slides with exact copy and storefront targets', () => {
  assert.deepEqual(
    LAUNCH_HERO_BANNERS.map(({ badge, title, subtitle, ctaLabel, href }) => ({ badge, title, subtitle, ctaLabel, href })),
    [
      {
        badge: 'DISCOVER ZYRO.LK',
        title: 'Upgrade Your Everyday',
        subtitle: 'Discover useful everyday products from trusted Sri Lankan suppliers.',
        ctaLabel: 'Shop Now',
        href: '/products',
      },
      {
        badge: 'SMART TECH',
        title: 'Smart Tech for Everyday Life',
        subtitle: 'Explore useful electronics, gadgets and accessories for work, home and play.',
        ctaLabel: 'Shop Electronics',
        href: '/categories/electronics',
      },
      {
        badge: 'ON THE ROAD',
        title: 'Drive Smarter',
        subtitle: 'Discover practical automotive accessories for everyday driving.',
        ctaLabel: 'Shop Automotive',
        href: '/categories/automotive',
      },
      {
        badge: 'EVERYDAY STYLE',
        title: 'Style for Every Day',
        subtitle: 'Explore fashion picks and accessories for your everyday look.',
        ctaLabel: 'Explore Fashion',
        href: '/categories/fashion',
      },
      {
        badge: 'SHOP WITH CONFIDENCE',
        title: 'Easy Shopping Across Sri Lanka',
        subtitle: 'Shop with Cash on Delivery and convenient islandwide delivery.',
        ctaLabel: 'Start Shopping',
        href: '/products',
      },
    ],
  );
  assert.equal(new Set(LAUNCH_HERO_BANNERS.map(banner => banner.id)).size, 5);
  assert.deepEqual(LAUNCH_HERO_BANNERS.map(banner => banner.theme), ['zyro', 'ocean', 'sky', 'sunrise', 'indigo']);
  assert.ok(LAUNCH_HERO_BANNERS.every(banner => banner.imageAlt.trim().length > 0));
  assert.ok(Object.isFrozen(LAUNCH_HERO_BANNERS));
});

test('image contract matches the approved artwork sizes', () => {
  assert.deepEqual({ ...LAUNCH_MERCHANDISING_IMAGE_CONTRACT.heroDesktop }, { width: 1600, height: 720 });
  assert.deepEqual({ ...LAUNCH_MERCHANDISING_IMAGE_CONTRACT.heroMobile }, { width: 1080, height: 960 });
  assert.deepEqual({ ...LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryCard }, { width: 800, height: 600 });
  assert.deepEqual({ ...LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryBanner }, { width: 1200, height: 600 });
  assert.deepEqual({ ...LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryCircle }, { width: 600, height: 600 });
});

test('hero targets resolve to storefront navigation without inventing routes', () => {
  assert.deepEqual(resolveLaunchHeroTarget('/products'), { kind: 'products' });
  assert.deepEqual(resolveLaunchHeroTarget(''), { kind: 'products' });
  assert.deepEqual(resolveLaunchHeroTarget('/categories'), { kind: 'categories' });
  assert.deepEqual(resolveLaunchHeroTarget('/categories/home-garden'), { kind: 'category', categoryId: 'home-garden' });
  assert.deepEqual(resolveLaunchHeroTarget('/search?q=phone'), { kind: 'internal', path: '/search?q=phone' });
  assert.deepEqual(resolveLaunchHeroTarget('//evil.test/x'), { kind: 'external', url: '//evil.test/x' });
  assert.deepEqual(resolveLaunchHeroTarget('https://zyro.lk/a'), { kind: 'external', url: 'https://zyro.lk/a' });
});

test('category priority ordering is stable and keeps unlisted categories', () => {
  const ordered = orderByCategoryPriority(
    ['kids-toys', 'health-beauty', 'solar-lighting', 'accessories', 'electronics', 'Home & Garden'],
    id => id,
    LAUNCH_FEATURED_CATEGORY_IDS,
  );
  assert.deepEqual(ordered, ['accessories', 'electronics', 'Home & Garden', 'health-beauty', 'kids-toys', 'solar-lighting']);
  assert.deepEqual(LAUNCH_FEATURED_CATEGORY_IDS, ['accessories', 'automotive', 'electronics', 'fashion', 'home-garden', 'health-beauty']);
  assert.deepEqual(LAUNCH_CATEGORY_BANNERS.map(banner => banner.categoryId), ['electronics', 'automotive']);
  assert.deepEqual(getLaunchCategoryArtwork('electronics'), {});
});

test('hero product visuals use only live products with images', () => {
  const products = [
    product('a1', 'accessories'),
    product('e1', 'electronics'),
    product('e2', 'electronics', ''),
    product('f1', 'fashion'),
    product('e3', 'electronics'),
    product('h1', 'home-garden'),
  ];
  assert.deepEqual(pickLaunchHeroProducts(products, ['electronics'], 3).map(item => item.id), ['e1', 'e3']);
  assert.deepEqual(pickLaunchHeroProducts(products, ['fashion', 'accessories'], 3).map(item => item.id), ['f1', 'a1']);
  assert.deepEqual(pickLaunchHeroProducts(products, [], 3).map(item => item.id), ['a1', 'e1', 'f1']);
  assert.deepEqual(pickLaunchHeroProducts(products, [], 3, 3).map(item => item.id), ['e3', 'h1', 'a1']);
  assert.deepEqual(pickLaunchHeroProducts(products, [], 2, 12).map(item => item.id), ['f1', 'e3']);
  assert.deepEqual(pickLaunchHeroProducts(products, ['automotive'], 3), []);
});

test('CMS hero slides are selected by enabled and structural state only, never by copy wording', () => {
  assert.match(hero, /settings\?\.heroBanners\?\.filter\(banner => banner\.enabled !== false\)/);
  assert.equal(isStructurallyValidHeroSlide({ title: 'Premium Electronics' }), true);
  assert.equal(isStructurallyValidHeroSlide({ title: 'Marketplace collection' }), true);
  assert.equal(isStructurallyValidHeroSlide({ title: 'Any campaign headline' }), true);
  assert.equal(isStructurallyValidHeroSlide({ title: '' }), false);
  assert.equal(isStructurallyValidHeroSlide({ title: '   ' }), false);
  assert.equal(isStructurallyValidHeroSlide({}), false);
  const cms = [{ title: '' }, { title: '  ' }].filter(isStructurallyValidHeroSlide);
  assert.equal(cms.length > 0 ? 'cms' : 'launch', 'launch');
  assert.equal([{ title: 'Premium Electronics' }].filter(isStructurallyValidHeroSlide).length > 0 ? 'cms' : 'launch', 'cms');
  assert.match(hero, /\.filter\(isStructurallyValidHeroSlide\)\s*\.sort\(compareHeroSlideOrder\);/);
  assert.match(hero, /cmsSlides\.length > 0 \? cmsSlides : launchSlides/);
  const cmsSelection = hero.slice(hero.indexOf('const configuredSlides'), hero.indexOf('const activeSlide'));
  assert.doesNotMatch(cmsSelection, /normalizeHeroPresentationText|LEGACY_HERO_COPY_PATTERN|PREMIUM_ELECTRONICS_PATTERN|replacePremiumElectronics/);
});

test('category visuals keep every category with products and fall back image by image', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const visuals = app.slice(app.indexOf('const homepageCategories = useMemo'), app.indexOf('const activeFilterCount'));
  assert.match(visuals, /if \(itemsCount === 0\) return \[\];/);
  assert.match(visuals, /const storedImage = category\.imageUrl\?\.trim\(\);/);
  assert.match(visuals, /const image = storedImage \|\| productImage \|\| '';/);
  assert.match(visuals, /return \[\{ category, image, itemsCount \}\];/);
  assert.doesNotMatch(visuals, /image \? \[/);
  assert.doesNotMatch(visuals, /\.slice\(0, 8\)/);
  assert.match(homepage, /data-placeholder=\{item\.kind === 'live' && !item\.image \? 'true' : undefined\}/);
  assert.match(homepage, /<b className="zy-category-monogram">\{getCategoryMonogram\(item\.name\)\}<\/b>/);
  assert.match(homepage, /onClick: \(\) => onSelectCategory\(category\.id\)/);
  assert.match(homepage, /id: category\.id,\s+name: formatCategoryDisplayName\(category\.name\)/);
});

test('category display names are presentation-only', () => {
  assert.equal(formatCategoryDisplayName('fashion'), 'Fashion');
  assert.equal(formatCategoryDisplayName('home & garden'), 'Home & Garden');
  assert.equal(formatCategoryDisplayName('Health & Beauty'), 'Health & Beauty');
  assert.equal(formatCategoryDisplayName('iPhone Cases'), 'iPhone Cases');
  assert.equal(formatCategoryDisplayName('  '), '');
  assert.equal(getCategoryMonogram('accessories'), 'A');
});

test('launch fallback slides keep one CTA and responsive artwork support', () => {
  assert.match(hero, /resolveLaunchHeroTarget\(target\)/);
  assert.match(hero, /onSelectCategory\(destination\.categoryId\)/);
  assert.match(hero, /<picture className="zy-campaign-hero-artwork">/);
  assert.match(hero, /media="\(max-width: 767px\)"/);
  assert.match(hero, /HERO_IMAGE_CONTRACT\.desktop\.width/);
  assert.match(hero, /HERO_IMAGE_CONTRACT\.mobile\.width/);
  assert.match(hero, /'--zy-ch-focal-desktop': stage\.focalPointDesktop/);
  assert.match(hero, /'--zy-ch-focal-mobile': stage\.focalPointMobile/);
  assert.doesNotMatch(hero, /premium electronics/i);
});

test('launch hero styles are mobile-first and respect reduced motion', () => {
  assert.match(launchStyles, /@media \(max-width: 767px\)/);
  assert.match(launchStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(launchStyles, /object-fit: cover/);
  assert.doesNotMatch(launchStyles, /@import/);
});

test('homepage keeps the approved merchandising order and category authority', () => {
  const order = [
    'zy-foundation-hero-wrap',
    'zy-foundation-category-dock',
    'zy-home-category-promos',
    'zy-home-secondary-promos',
    "id: 'homepage-flash-deals'",
    "id: 'homepage-recommended-products'",
  ];
  const positions = order.map(marker => homepage.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.match(homepage, /onClick: \(\) => onSelectCategory\(category\.id\)/);
  assert.match(homepage, /Discover more/);
  assert.match(homepage, /LAUNCH_MERCHANDISING_IMAGE_CONTRACT\.categoryCard/);
  assert.match(homepage, /LAUNCH_MERCHANDISING_IMAGE_CONTRACT\.categoryBanner/);
});
