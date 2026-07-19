import type { WebsiteSettings } from '../../types';

export const DEFAULT_HOMEPAGE_SECTIONS: NonNullable<WebsiteSettings['homepageSections']> = {
  flashDeals: {
    enabled: true,
    title: 'Flash Deals',
    subtitle: 'Genuine savings from products with a verified regular price and lower selling price.',
  },
  featured: {
    enabled: true,
    title: 'Featured Products',
    subtitle: 'Storefront highlights selected from the currently published marketplace catalog.',
  },
  newArrivals: {
    enabled: true,
    title: 'New Arrivals',
    subtitle: 'Fresh additions available now from the live Zyro.lk catalog.',
  },
  bestSellers: {
    enabled: true,
    title: 'Best Sellers',
    subtitle: 'Popular marketplace picks identified from the live product catalog.',
  },
  recommended: {
    enabled: true,
    title: 'Recommended Products',
    subtitle: 'A convenient starting point selected from products currently available in the marketplace.',
  },
};

export const DEFAULT_WEBSITE_SETTINGS: WebsiteSettings = {
  storeName: 'Zyro.lk',
  storeTagline: "Sri Lanka's Premium Marketplace",
  logoUrl: '',
  faviconUrl: '',
  contactPhone: '',
  contactPhone2: '',
  whatsappNumber: '',
  contactEmail: '',
  contactAddress: '',
  heroBanners: [],
  autoSlideSpeed: 6,
  enableSlider: true,
  homepageSections: DEFAULT_HOMEPAGE_SECTIONS,
  primaryColor: '#2563EB',
  secondaryColor: '#10B981',
  footerLogoUrl: '',
  aboutText: '',
  copyrightText: '© 2026 Zyro.lk. All rights reserved.',
  facebookUrl: '',
  instagramUrl: '',
  tiktokUrl: '',
  youtubeUrl: '',
  seoTitle: 'Zyro.lk',
  seoDescription: 'Shop the live Zyro.lk marketplace catalog.',
  seoKeywords: '',
  ogImageUrl: '',
  deliveryCharge: 500,
  freeDeliveryMin: 150000,
  deliveryAreas: [],
  currency: 'LKR',
  businessHours: { weekdays: '9:00 AM - 6:00 PM', saturday: '9:00 AM - 5:00 PM', sunday: 'Closed' },
  storeStatus: 'open',
  storeStatusMessage: '',
  enableCOD: true,
  enableWishlist: true,
  enableReviews: true,
  enableFeaturedProducts: true,
  maintenanceMode: false,
  maintenanceMessage: 'Zyro.lk is temporarily unavailable while scheduled maintenance is completed.',
  registrationEnabled: true,
  supplierRegistrationEnabled: false,
  emailNotificationsEnabled: true,
  orderNotificationsEnabled: true,
};

const section = (
  value: Partial<NonNullable<WebsiteSettings['homepageSections']>[keyof NonNullable<WebsiteSettings['homepageSections']>]> | undefined,
  fallback: NonNullable<WebsiteSettings['homepageSections']>[keyof NonNullable<WebsiteSettings['homepageSections']>],
) => ({ ...fallback, ...(value || {}) });

export function normalizeWebsiteSettings(value: Partial<WebsiteSettings> | null | undefined): WebsiteSettings {
  const source = value || {};
  return {
    ...DEFAULT_WEBSITE_SETTINGS,
    ...source,
    heroBanners: Array.isArray(source.heroBanners) ? source.heroBanners : [],
    deliveryAreas: Array.isArray(source.deliveryAreas) ? source.deliveryAreas : [],
    businessHours: { ...DEFAULT_WEBSITE_SETTINGS.businessHours!, ...(source.businessHours || {}) },
    homepageSections: {
      flashDeals: section(source.homepageSections?.flashDeals, DEFAULT_HOMEPAGE_SECTIONS.flashDeals),
      featured: section(source.homepageSections?.featured, DEFAULT_HOMEPAGE_SECTIONS.featured),
      newArrivals: section(source.homepageSections?.newArrivals, DEFAULT_HOMEPAGE_SECTIONS.newArrivals),
      bestSellers: section(source.homepageSections?.bestSellers, DEFAULT_HOMEPAGE_SECTIONS.bestSellers),
      recommended: section(source.homepageSections?.recommended, DEFAULT_HOMEPAGE_SECTIONS.recommended),
    },
    currency: 'LKR',
  };
}
