import type { Category, Product } from '../../types';
import { categoryMatches } from '../categories/categoryUtils';
import { DEFAULT_HERO_FOCAL_POINT, HERO_IMAGE_CONTRACT, type HeroCampaignSlide, type HeroTheme } from '../hero-slider/heroSlider';

export interface MerchandisingImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Artwork targets for launch merchandising. Dedicated assets are optional:
 * when a field is empty the storefront composes the slot from live product imagery.
 */
export const LAUNCH_MERCHANDISING_IMAGE_CONTRACT = Object.freeze({
  heroDesktop: HERO_IMAGE_CONTRACT.desktop,
  heroMobile: HERO_IMAGE_CONTRACT.mobile,
  categoryCard: Object.freeze({ width: 800, height: 600 }),
  categoryBanner: Object.freeze({ width: 1200, height: 600 }),
  categoryCircle: Object.freeze({ width: 600, height: 600 }),
} satisfies Record<string, MerchandisingImageSize>);

export interface LaunchHeroBanner {
  readonly id: string;
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly ctaLabel: string;
  /** Internal storefront path: /products, /categories or /categories/{categoryId}. */
  readonly href: string;
  /** 1600 × 720 artwork. Keep headline-safe space on the left 45%. */
  readonly desktopImage: string;
  /** 1080 × 960 artwork. Keep headline-safe space on the top 45%. */
  readonly mobileImage: string;
  readonly imageAlt: string;
  /** CSS object-position for dedicated artwork, e.g. "70% 50%". */
  readonly focalPointDesktop: string;
  readonly focalPointMobile: string;
  readonly theme: HeroTheme;
  /** Live categories used for the product visual when no artwork is configured. Empty means the whole catalogue. */
  readonly visualCategoryIds: readonly string[];
  readonly visualOffset: number;
}

export const LAUNCH_HERO_BANNERS: readonly LaunchHeroBanner[] = Object.freeze(([
  {
    id: 'launch-marketplace',
    badge: 'DISCOVER ZYRO.LK',
    title: 'Upgrade Your Everyday',
    subtitle: 'Discover useful everyday products from trusted Sri Lankan suppliers.',
    ctaLabel: 'Shop Now',
    href: '/products',
    desktopImage: '/launch/hero-main-desktop.png',
    mobileImage: '/launch/hero-main-mobile.png',
    imageAlt: 'Everyday products available on Zyro.lk',
    focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
    focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
    theme: 'zyro',
    visualCategoryIds: [],
    visualOffset: 0,
  },
  {
    id: 'launch-electronics',
    badge: 'SMART TECH',
    title: 'Smart Tech for Everyday Life',
    subtitle: 'Explore useful electronics, gadgets and accessories for work, home and play.',
    ctaLabel: 'Shop Electronics',
    href: '/categories/electronics',
    desktopImage: '/launch/hero-electronics-desktop.png',
    mobileImage: '/launch/hero-electronics-mobile.png',
    imageAlt: 'Electronics and gadgets on Zyro.lk',
    focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
    focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
    theme: 'ocean',
    visualCategoryIds: ['electronics'],
    visualOffset: 0,
  },
  {
    id: 'launch-automotive',
    badge: 'ON THE ROAD',
    title: 'Drive Smarter',
    subtitle: 'Discover practical automotive accessories for everyday driving.',
    ctaLabel: 'Shop Automotive',
    href: '/categories/automotive',
    desktopImage: '/launch/hero-automotive-desktop.png',
    mobileImage: '/launch/hero-automotive-mobile.png',
    imageAlt: 'Automotive accessories on Zyro.lk',
    focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
    focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
    theme: 'sky',
    visualCategoryIds: ['automotive'],
    visualOffset: 0,
  },
  {
    id: 'launch-fashion',
    badge: 'EVERYDAY STYLE',
    title: 'Style for Every Day',
    subtitle: 'Explore fashion picks and accessories for your everyday look.',
    ctaLabel: 'Explore Fashion',
    href: '/categories/fashion',
    desktopImage: '/launch/hero-fashion-desktop.png',
    mobileImage: '/launch/hero-fashion-mobile.png',
    imageAlt: 'Fashion and accessories on Zyro.lk',
    focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
    focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
    theme: 'sunrise',
    visualCategoryIds: ['fashion', 'accessories'],
    visualOffset: 0,
  },
  {
    id: 'launch-cash-on-delivery',
    badge: 'SHOP WITH CONFIDENCE',
    title: 'Easy Shopping Across Sri Lanka',
    subtitle: 'Shop with Cash on Delivery and convenient islandwide delivery.',
    ctaLabel: 'Start Shopping',
    href: '/products',
    desktopImage: '/launch/hero-delivery-desktop.png',
    mobileImage: '/launch/hero-delivery-mobile.png',
    imageAlt: 'Products delivered across Sri Lanka',
    focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
    focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
    theme: 'indigo',
    visualCategoryIds: [],
    visualOffset: 3,
  },
] satisfies LaunchHeroBanner[]).map(banner => Object.freeze({ ...banner, visualCategoryIds: Object.freeze([...banner.visualCategoryIds]) })));

/** Launch fallback expressed in the same shape as a CMS slide. */
export const toLaunchHeroSlide = (banner: LaunchHeroBanner, index: number): HeroCampaignSlide => ({
  id: banner.id,
  badge: banner.badge,
  title: banner.title,
  subtitle: banner.subtitle,
  description: '',
  image: banner.desktopImage,
  mobileImage: banner.mobileImage,
  imageAlt: banner.imageAlt,
  focalPointDesktop: banner.focalPointDesktop,
  focalPointMobile: banner.focalPointMobile,
  theme: banner.theme,
  cta: banner.ctaLabel,
  ctaUrl: banner.href,
  sortOrder: index,
  visualCategoryIds: banner.visualCategoryIds,
  visualOffset: banner.visualOffset,
});

/** Featured category grid priority. IDs must match live category documents; missing ones are skipped. */
export const LAUNCH_FEATURED_CATEGORY_IDS: readonly string[] = Object.freeze([
  'accessories',
  'automotive',
  'electronics',
  'fashion',
  'home-garden',
  'health-beauty',
]);

export type LaunchCategoryBannerTone = 'warm' | 'cool';

export interface LaunchCategoryBanner {
  readonly categoryId: string;
  readonly tone: LaunchCategoryBannerTone;
}

export const LAUNCH_CATEGORY_BANNERS: readonly LaunchCategoryBanner[] = Object.freeze([
  Object.freeze({ categoryId: 'electronics', tone: 'cool' as const }),
  Object.freeze({ categoryId: 'automotive', tone: 'warm' as const }),
]);

export interface LaunchCategoryArtwork {
  /** 1200 × 600 banner artwork. */
  readonly bannerImage?: string;
}

/** Optional dedicated category artwork keyed by category ID. */
export const LAUNCH_CATEGORY_ARTWORK: Readonly<Record<string, LaunchCategoryArtwork>> = Object.freeze({});

export const getLaunchCategoryArtwork = (categoryId: string): LaunchCategoryArtwork => {
  const match = Object.entries(LAUNCH_CATEGORY_ARTWORK).find(([id]) => categoryMatches(id, categoryId));
  return match?.[1] || {};
};

/** Presentation-only label: stored names are kept unless they are entirely lowercase. IDs and routes never use this. */
export const formatCategoryDisplayName = (name: string): string => {
  const clean = name.trim();
  if (!clean || clean !== clean.toLocaleLowerCase()) return clean;
  return clean.replace(/(^|[\s&/-])(\p{Ll})/gu, (_match, separator: string, letter: string) => `${separator}${letter.toLocaleUpperCase()}`);
};

/** Readable fallback for an ID with no loaded category, e.g. "home-garden" -> "Home Garden". */
export const humanizeCategoryId = (value: string): string =>
  value
    .replace(/[-_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase()
    .replace(/(^|\s)(\p{Ll})/gu, (_match, separator: string, letter: string) => `${separator}${letter.toLocaleUpperCase()}`);

/** Presentation-only label for a category ID; the loaded category name is the authority. IDs and routes never use this. */
export const resolveCategoryDisplayName = (
  categoryId: string | undefined,
  categories: readonly Readonly<Pick<Category, 'id' | 'name'>>[],
): string => {
  const id = categoryId?.trim() || '';
  if (!id) return '';
  const match = categories.find((category) => categoryMatches(category.id, id));
  return (match && formatCategoryDisplayName(match.name)) || humanizeCategoryId(id);
};

export const getCategoryMonogram = (name: string): string =>
  Array.from(formatCategoryDisplayName(name))[0] || '';

export type LaunchHeroTarget =
  | { kind: 'products' }
  | { kind: 'categories' }
  | { kind: 'category'; categoryId: string }
  | { kind: 'internal'; path: string }
  | { kind: 'external'; url: string };

export const resolveLaunchHeroTarget = (href: string | undefined): LaunchHeroTarget => {
  const target = (href || '').trim();
  if (!target || target === '/products') return { kind: 'products' };
  if (target === '/categories') return { kind: 'categories' };
  const categoryMatch = /^\/categories\/([^/?#]+)\/?$/u.exec(target);
  if (categoryMatch) return { kind: 'category', categoryId: decodeURIComponent(categoryMatch[1]) };
  if (target.startsWith('/') && !target.startsWith('//')) return { kind: 'internal', path: target };
  return { kind: 'external', url: target };
};

/** Orders items by the priority category list, then keeps the remaining items in their existing order. */
export const orderByCategoryPriority = <T>(
  items: readonly T[],
  getCategoryId: (item: T) => string,
  priorityIds: readonly string[],
): T[] => {
  const rank = (item: T) => {
    const index = priorityIds.findIndex(id => categoryMatches(getCategoryId(item), id));
    return index < 0 ? priorityIds.length : index;
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.item);
};

/** Picks live products with images for a hero visual, preferring distinct categories for catalogue-wide slides. */
export const pickLaunchHeroProducts = (
  products: readonly Product[],
  visualCategoryIds: readonly string[],
  count: number,
  offset = 0,
): Product[] => {
  const withImages = products.filter(product => Boolean(product.imageUrl?.trim()));
  if (visualCategoryIds.length > 0) {
    const matching = withImages.filter(product => visualCategoryIds.some(id => categoryMatches(product.category, id)));
    return orderByCategoryPriority(matching, product => product.category, visualCategoryIds).slice(0, count);
  }
  const start = withImages.length > 0 ? offset % withImages.length : 0;
  const rotated = [...withImages.slice(start), ...withImages.slice(0, start)];
  const seenCategories = new Set<string>();
  const distinct: Product[] = [];
  for (const product of rotated) {
    const key = product.category || '';
    if (seenCategories.has(key)) continue;
    seenCategories.add(key);
    distinct.push(product);
    if (distinct.length === count) return distinct;
  }
  const remaining = rotated.filter(product => !distinct.includes(product));
  return [...distinct, ...remaining].slice(0, count);
};
