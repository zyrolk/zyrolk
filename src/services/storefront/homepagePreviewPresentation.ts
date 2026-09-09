import { PREVIEW_PRODUCT_ID_PREFIX } from './previewCommerceGuard';

export type HomepagePreviewTone = 'orange' | 'blue' | 'green' | 'pink' | 'yellow';
export type HomepagePreviewShelf = 'deals' | 'featured' | 'new' | 'best-seller' | 'recommended';

export interface HomepagePreviewHero {
  id: `${typeof PREVIEW_PRODUCT_ID_PREFIX}hero:${string}`;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  bgGradient: string;
  cta: string;
  ctaUrl: '/products';
}

export interface HomepagePreviewCategory {
  id: `${typeof PREVIEW_PRODUCT_ID_PREFIX}category:${string}`;
  name: string;
  tone: HomepagePreviewTone;
  art: 'mobile' | 'audio' | 'watch' | 'electronics' | 'power' | 'car' | 'home' | 'accessories' | 'more';
}

export interface HomepagePreviewPromo {
  id: `${typeof PREVIEW_PRODUCT_ID_PREFIX}promo:${string}`;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  tone: HomepagePreviewTone;
  categoryName: string;
  art: HomepagePreviewCategory['art'];
}

export interface HomepagePreviewBanner {
  id: `${typeof PREVIEW_PRODUCT_ID_PREFIX}banner:${string}`;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  tone: HomepagePreviewTone;
  categoryName: string;
  art: HomepagePreviewCategory['art'];
}

export interface HomepagePreviewProduct {
  id: `${typeof PREVIEW_PRODUCT_ID_PREFIX}product:${string}`;
  name: string;
  category: string;
  shelf: HomepagePreviewShelf;
  tone: HomepagePreviewTone;
  art: HomepagePreviewCategory['art'];
}

export interface HomepagePreviewPresentation {
  hero: HomepagePreviewHero;
  categories: readonly HomepagePreviewCategory[];
  promos: readonly HomepagePreviewPromo[];
  banners: readonly HomepagePreviewBanner[];
  products: readonly HomepagePreviewProduct[];
}

/**
 * This is presentation-only local content. It is intentionally not shaped as
 * Product, Category, CartItem, or any Firestore document.
 */
const DEV_PREVIEW_PRESENTATION: HomepagePreviewPresentation = {
  hero: {
    id: 'preview:hero:reference',
    badge: 'NEW ARRIVALS',
    title: 'Upgrade Your Everyday',
    subtitle: 'Mobile accessories, audio and everyday tech in one place at Zyro.lk.',
    description: 'Shop real collections with Cash on Delivery and islandwide delivery.',
    image: '',
    bgGradient: 'orange',
    cta: 'Shop Now',
    ctaUrl: '/products',
  },
  categories: [
    { id: 'preview:category:mobile-accessories', name: 'Mobile Accessories', tone: 'blue', art: 'mobile' },
    { id: 'preview:category:audio', name: 'Audio', tone: 'pink', art: 'audio' },
    { id: 'preview:category:smart-watches', name: 'Smart Watches', tone: 'yellow', art: 'watch' },
    { id: 'preview:category:electronics', name: 'Electronics', tone: 'blue', art: 'electronics' },
    { id: 'preview:category:power', name: 'Power & Chargers', tone: 'green', art: 'power' },
    { id: 'preview:category:car-accessories', name: 'Car Accessories', tone: 'orange', art: 'car' },
    { id: 'preview:category:home-living', name: 'Home & Living', tone: 'yellow', art: 'home' },
    { id: 'preview:category:accessories', name: 'Accessories', tone: 'pink', art: 'accessories' },
    { id: 'preview:category:more', name: 'More', tone: 'blue', art: 'more' },
  ],
  promos: [
    {
      id: 'preview:promo:mobile-accessories',
      eyebrow: 'MOBILE ACCESSORIES',
      title: 'Everyday mobile essentials',
      subtitle: 'Cases, cables and useful add-ons.',
      cta: 'Shop now',
      tone: 'orange',
      categoryName: 'Mobile Accessories',
      art: 'mobile',
    },
    {
      id: 'preview:promo:audio',
      eyebrow: 'AUDIO ZONE',
      title: 'Feel the beat',
      subtitle: 'Explore audio for everyday listening.',
      cta: 'Explore',
      tone: 'blue',
      categoryName: 'Audio',
      art: 'audio',
    },
    {
      id: 'preview:promo:power',
      eyebrow: 'POWER UP',
      title: 'Power & chargers',
      subtitle: 'Keep your everyday devices ready.',
      cta: 'Shop now',
      tone: 'green',
      categoryName: 'Power & Chargers',
      art: 'power',
    },
    {
      id: 'preview:promo:accessories',
      eyebrow: 'ACCESSORIES',
      title: 'Style it your way',
      subtitle: 'Practical accessories for every day.',
      cta: 'Explore',
      tone: 'pink',
      categoryName: 'Accessories',
      art: 'accessories',
    },
  ],
  banners: [
    {
      id: 'preview:banner:tech-essentials',
      eyebrow: 'LAPTOPS & ACCESSORIES',
      title: 'Work, study, create better',
      subtitle: 'Discover everyday tech essentials.',
      cta: 'Shop now',
      tone: 'blue',
      categoryName: 'Electronics',
      art: 'electronics',
    },
    {
      id: 'preview:banner:home-essentials',
      eyebrow: 'HOME ESSENTIALS',
      title: 'Make home sweeter',
      subtitle: 'Explore useful products for your space.',
      cta: 'Shop now',
      tone: 'yellow',
      categoryName: 'Home & Living',
      art: 'home',
    },
  ],
  products: [
    { id: 'preview:product:mobile-essentials', name: 'Mobile Essentials', category: 'Mobile Accessories', shelf: 'recommended', tone: 'blue', art: 'mobile' },
    { id: 'preview:product:audio-essentials', name: 'Audio Essentials', category: 'Audio', shelf: 'recommended', tone: 'pink', art: 'audio' },
    { id: 'preview:product:smart-watches', name: 'Smart Watches', category: 'Smart Watches', shelf: 'recommended', tone: 'yellow', art: 'watch' },
    { id: 'preview:product:power-essentials', name: 'Power Essentials', category: 'Power & Chargers', shelf: 'recommended', tone: 'green', art: 'power' },
    { id: 'preview:product:everyday-electronics', name: 'Everyday Electronics', category: 'Electronics', shelf: 'recommended', tone: 'blue', art: 'electronics' },
    { id: 'preview:product:accessories', name: 'Everyday Accessories', category: 'Accessories', shelf: 'recommended', tone: 'orange', art: 'accessories' },
  ],
};

export const HOMEPAGE_PREVIEW_PRESENTATION: HomepagePreviewPresentation | null = import.meta.env.DEV
  ? DEV_PREVIEW_PRESENTATION
  : null;

export function isHomepagePreviewEnabled(): boolean {
  return import.meta.env.DEV === true;
}

export function getHomepagePreviewPresentation(
  enabled = isHomepagePreviewEnabled(),
): HomepagePreviewPresentation | null {
  return enabled ? DEV_PREVIEW_PRESENTATION : null;
}
