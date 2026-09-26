import { HeroBannerSettings } from '../../types';

export const HERO_SLIDE_SPEED_MIN = 2;
export const HERO_SLIDE_SPEED_MAX = 30;
export const HERO_SLIDE_LIMIT = 10;

export const HERO_IMAGE_CONTRACT = Object.freeze({
  desktop: Object.freeze({ width: 1600, height: 720 }),
  mobile: Object.freeze({ width: 1080, height: 960 }),
});

export const HERO_THEMES = ['zyro', 'ocean', 'sky', 'sunrise', 'indigo'] as const;
export type HeroTheme = typeof HERO_THEMES[number];

export const HERO_THEME_LABELS: Readonly<Record<HeroTheme, string>> = Object.freeze({
  zyro: 'Zyro blue & warm orange',
  ocean: 'Deep blue',
  sky: 'Sky blue',
  sunrise: 'Warm orange',
  indigo: 'Indigo',
});

export const HERO_FOCAL_POINT_PRESETS: ReadonlyArray<{ readonly value: string; readonly label: string }> = Object.freeze([
  { value: '50% 50%', label: 'Centre' },
  { value: '70% 50%', label: 'Right' },
  { value: '30% 50%', label: 'Left' },
  { value: '50% 30%', label: 'Top' },
  { value: '50% 70%', label: 'Bottom' },
  { value: '75% 70%', label: 'Bottom right' },
]);

export const DEFAULT_HERO_FOCAL_POINT = '70% 50%';

export interface HeroSlideValidationError {
  field: keyof HeroBannerSettings | 'slides';
  message: string;
}

export const isHeroTheme = (value: unknown): value is HeroTheme =>
  typeof value === 'string' && (HERO_THEMES as readonly string[]).includes(value);

const FOCAL_POINT_PATTERN = /^(\d{1,3})% (\d{1,3})%$/u;

export const isValidHeroFocalPoint = (value: string): boolean => {
  const match = FOCAL_POINT_PATTERN.exec(value.trim());
  return Boolean(match && Number(match[1]) <= 100 && Number(match[2]) <= 100);
};

export const normalizeHeroFocalPoint = (value: string | undefined, fallback = DEFAULT_HERO_FOCAL_POINT): string =>
  value && isValidHeroFocalPoint(value) ? value.trim() : fallback;

export const createHeroSlide = (id = `hero-${Date.now()}`): HeroBannerSettings => ({
  id,
  badge: 'FEATURED',
  title: 'New promotional slide',
  subtitle: '',
  description: '',
  image: '',
  mobileImage: '',
  imageAlt: '',
  focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
  focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
  theme: 'zyro',
  bgGradient: 'from-black via-zinc-950/90 to-blue-950/20',
  buttonText: 'Shop Now',
  buttonUrl: '/products',
  enabled: true,
});

export const duplicateHeroSlide = (slide: HeroBannerSettings, id = `hero-${Date.now()}`): HeroBannerSettings => ({
  ...slide,
  id,
  title: `${slide.title} (Copy)`,
});

/** Writes the array position into `sortOrder` so storefront order matches the admin list. */
export const withSequentialHeroSortOrder = (slides: readonly HeroBannerSettings[]): HeroBannerSettings[] =>
  slides.map((slide, index) => ({ ...slide, sortOrder: index }));

export const isSafeHeroUrl = (value: string): boolean => {
  const url = value.trim();
  if (!url) return true;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const isSafeHeroImageUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

export const validateHeroSlide = (slide: HeroBannerSettings): HeroSlideValidationError[] => {
  const errors: HeroSlideValidationError[] = [];
  if (!slide.title.trim()) errors.push({ field: 'title', message: 'Title is required.' });
  if (!slide.image.trim()) errors.push({ field: 'image', message: 'Image is required.' });
  const hasCtaLabel = Boolean(slide.buttonText?.trim());
  if (hasCtaLabel && slide.buttonUrl && !isSafeHeroUrl(slide.buttonUrl)) {
    errors.push({ field: 'buttonUrl', message: 'Use an internal path or an http/https URL.' });
  }
  if (slide.mobileImage?.trim() && !isSafeHeroImageUrl(slide.mobileImage)) {
    errors.push({ field: 'mobileImage', message: 'Mobile image must be an http/https URL.' });
  }
  if (slide.theme !== undefined && slide.theme !== '' && !isHeroTheme(slide.theme)) {
    errors.push({ field: 'theme', message: 'Choose one of the approved hero themes.' });
  }
  for (const field of ['focalPointDesktop', 'focalPointMobile'] as const) {
    const value = slide[field];
    if (value && !isValidHeroFocalPoint(value)) {
      errors.push({ field, message: 'Focal point must look like "70% 50%".' });
    }
  }
  return errors;
};

export const validateHeroSlides = (slides: HeroBannerSettings[]): HeroSlideValidationError[] => {
  const errors = slides.flatMap(validateHeroSlide);
  if (slides.length > HERO_SLIDE_LIMIT) {
    errors.push({ field: 'slides', message: `A maximum of ${HERO_SLIDE_LIMIT} slides is supported.` });
  }
  const ids = new Set<string>();
  if (slides.some((slide) => ids.size === ids.add(slide.id).size)) {
    errors.push({ field: 'slides', message: 'Every slide must have a unique ID.' });
  }
  return errors;
};

export const normalizeSlideSpeed = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return 6;
  return Math.min(HERO_SLIDE_SPEED_MAX, Math.max(HERO_SLIDE_SPEED_MIN, Number(value)));
};

/** Storefront presentation of one hero slide, shared by CMS banners and launch fallbacks. */
export interface HeroCampaignSlide {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  /** Desktop artwork. */
  image: string;
  mobileImage: string;
  imageAlt: string;
  focalPointDesktop: string;
  focalPointMobile: string;
  theme: HeroTheme;
  cta: string;
  ctaUrl: string;
  sortOrder: number;
  visualCategoryIds: readonly string[];
  visualOffset: number;
}

const LEGACY_WARM_GRADIENT_PATTERN = /orange|amber|stone/u;

const themeForBanner = (banner: HeroBannerSettings, index: number): HeroTheme => {
  if (isHeroTheme(banner.theme)) return banner.theme;
  if (banner.bgGradient && LEGACY_WARM_GRADIENT_PATTERN.test(banner.bgGradient)) return 'sunrise';
  return HERO_THEMES[index % HERO_THEMES.length];
};

const CATEGORY_PATH_PATTERN = /^\/categories\/([^/?#]+)\/?$/u;

export const toHeroCampaignSlide = (banner: HeroBannerSettings, index: number): HeroCampaignSlide => {
  const ctaUrl = banner.buttonUrl?.trim() || '';
  const categoryMatch = CATEGORY_PATH_PATTERN.exec(ctaUrl);
  const focalPointDesktop = normalizeHeroFocalPoint(banner.focalPointDesktop);
  return {
    id: banner.id || `banner-${index}`,
    badge: banner.badge?.trim() || '',
    title: banner.title?.trim() || '',
    subtitle: banner.subtitle?.trim() || '',
    description: banner.description?.trim() || '',
    image: banner.image?.trim() || '',
    mobileImage: banner.mobileImage?.trim() || '',
    imageAlt: banner.imageAlt?.trim() || '',
    focalPointDesktop,
    focalPointMobile: normalizeHeroFocalPoint(banner.focalPointMobile, focalPointDesktop),
    theme: themeForBanner(banner, index),
    cta: banner.buttonText?.trim() || '',
    ctaUrl,
    sortOrder: Number.isFinite(banner.sortOrder) ? Number(banner.sortOrder) : index,
    visualCategoryIds: categoryMatch ? [decodeURIComponent(categoryMatch[1])] : [],
    visualOffset: index * 2,
  };
};

/** A CMS hero slide is usable when it has a headline; its wording is never inspected. */
export const isStructurallyValidHeroSlide = (slide: { readonly title?: string | null }): boolean =>
  Boolean(slide.title?.trim());

export const compareHeroSlideOrder = (left: HeroCampaignSlide, right: HeroCampaignSlide): number =>
  left.sortOrder - right.sortOrder;

/** Mobile artwork wins on small screens; the desktop artwork is the fallback. */
export const resolveHeroArtwork = (slide: Pick<HeroCampaignSlide, 'image' | 'mobileImage'>) => ({
  desktop: slide.image || slide.mobileImage,
  mobile: slide.mobileImage || slide.image,
  hasArtwork: Boolean(slide.image || slide.mobileImage),
});
