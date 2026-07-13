import { HeroBannerSettings } from '../../types';

export const HERO_SLIDE_SPEED_MIN = 2;
export const HERO_SLIDE_SPEED_MAX = 30;
export const HERO_SLIDE_LIMIT = 10;

export interface HeroSlideValidationError {
  field: keyof HeroBannerSettings | 'slides';
  message: string;
}

export const createHeroSlide = (id = `hero-${Date.now()}`): HeroBannerSettings => ({
  id,
  badge: 'FEATURED',
  title: 'New promotional slide',
  subtitle: '',
  description: '',
  image: '',
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

export const validateHeroSlide = (slide: HeroBannerSettings): HeroSlideValidationError[] => {
  const errors: HeroSlideValidationError[] = [];
  if (!slide.title.trim()) errors.push({ field: 'title', message: 'Title is required.' });
  if (!slide.image.trim()) errors.push({ field: 'image', message: 'Image is required.' });
  const hasCtaLabel = Boolean(slide.buttonText?.trim());
  if (hasCtaLabel && slide.buttonUrl && !isSafeHeroUrl(slide.buttonUrl)) {
    errors.push({ field: 'buttonUrl', message: 'Use an internal path or an http/https URL.' });
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
