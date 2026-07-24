import { Product, WebsiteSettings } from '../../types';

const DEFAULT_ORIGIN = 'https://zyro.lk';
const DEFAULT_DESCRIPTION = 'Shop live collections across home, beauty, fashion, electronics, lifestyle, accessories and more from one trusted Sri Lankan marketplace.';

const PAGE_COPY: Record<string, { title: string; description: string }> = {
  home: {
    title: 'A Trusted Sri Lankan Marketplace',
    description: DEFAULT_DESCRIPTION,
  },
  products: {
    title: 'Shop Products',
    description: 'Browse live marketplace products with current pricing, availability, categories and convenient ordering.',
  },
  categories: {
    title: 'Shop by Category',
    description: 'Explore active Zyro.lk marketplace collections and discover currently published products by category.',
  },
  wishlist: {
    title: 'Your Wishlist',
    description: 'Review the marketplace products you have saved while comparing your options.',
  },
  'recently-viewed': { title: 'Recently Viewed', description: 'Continue exploring products recently viewed on Zyro.lk.' },
  compare: { title: 'Compare Products', description: 'Compare live Zyro.lk products across pricing, availability, and specifications.' },
  account: { title: 'My Account', description: 'Manage your Zyro.lk customer account.' },
  'account-orders': { title: 'My Orders', description: 'Review and track your private Zyro.lk order history.' },
  'account-order-details': { title: 'Order Details', description: 'Review private Zyro.lk order details and fulfilment progress.' },
  'account-profile': { title: 'Account Profile', description: 'Manage your Zyro.lk account profile.' },
  'account-addresses': { title: 'Address Book', description: 'Manage your private Zyro.lk delivery address book.' },
  'account-security': { title: 'Account Security', description: 'Review your Zyro.lk account security and sign-in information.' },
  'account-settings': { title: 'Customer Settings', description: 'Manage your Zyro.lk customer communication preferences.' },
  'payment-return': { title: 'Payment Status', description: 'Securely verify the status of your Zyro.lk payment.' },
  contact: {
    title: 'Contact & Support',
    description: 'Contact Zyro.lk for marketplace support, product questions and ordering assistance.',
  },
  'about-us': { title: 'About Us', description: 'Learn more about the Zyro.lk Sri Lankan marketplace.' },
  faq: { title: 'FAQs & Guides', description: 'Find Zyro.lk marketplace guidance and answers to common shopping questions.' },
  'return-policy': { title: 'Purchase Support Policy', description: 'Read the Zyro.lk purchase support policy.' },
  'terms-conditions': { title: 'Terms & Conditions', description: 'Read the terms and conditions for using Zyro.lk.' },
  'privacy-policy': { title: 'Privacy Policy', description: 'Read how Zyro.lk handles customer and storefront information.' },
  admin: { title: 'Admin Dashboard', description: 'Zyro.lk storefront administration.' },
};

const cleanText = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
const truncate = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, limit - 3).trimEnd()}...`;

const safeOrigin = (origin?: string): string => {
  try {
    const parsed = new URL(origin || DEFAULT_ORIGIN);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : DEFAULT_ORIGIN;
  } catch {
    return DEFAULT_ORIGIN;
  }
};

const absoluteHttpUrl = (value: unknown, origin: string): string | undefined => {
  const candidate = cleanText(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate, origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
};

export interface StorefrontSeoInput {
  currentPage: string;
  product?: Product | null;
  settings?: WebsiteSettings | null;
  origin?: string;
  isAdminMode?: boolean;
}

export interface StorefrontSeoDescriptor {
  title: string;
  description: string;
  keywords: string;
  siteName: string;
  locale: string;
  image?: string;
  imageAlt?: string;
  canonical: string;
  type: 'website' | 'product';
  robots: string;
  structuredData: Record<string, unknown>;
}

export const buildStorefrontSeo = ({ currentPage, product, settings, origin, isAdminMode = false }: StorefrontSeoInput): StorefrontSeoDescriptor => {
  const resolvedOrigin = safeOrigin(origin);
  const canonical = product?.id
    ? `${resolvedOrigin}/?product=${encodeURIComponent(product.id)}`
    : `${resolvedOrigin}/`;
  const storeName = cleanText(settings?.storeName) || 'Zyro.lk';
  const pageCopy = PAGE_COPY[currentPage === 'legacy-home' ? 'home' : currentPage] || {
    title: 'Page Not Found',
    description: 'The requested Zyro.lk storefront page could not be found.',
  };
  const productName = cleanText(product?.name);
  const productDescription = cleanText(product?.description);
  const configuredSeoTitle = cleanText(settings?.seoTitle);
  const settingsDescription = cleanText(settings?.seoDescription);
  const isProduct = Boolean(product && productName);
  const isMissingPage = !PAGE_COPY[currentPage] && currentPage !== 'legacy-home';
  const title = isAdminMode
    ? `Admin Dashboard | ${storeName}`
    : isProduct
      ? `${productName} | ${storeName}`
      : currentPage === 'home' || currentPage === 'legacy-home'
        ? configuredSeoTitle || `${storeName} | ${pageCopy.title}`
        : `${pageCopy.title} | ${storeName}`;
  const description = truncate(
    isProduct
      ? productDescription || `View current pricing, availability and product details for ${productName} on ${storeName}.`
      : currentPage === 'home' || currentPage === 'legacy-home'
        ? settingsDescription || pageCopy.description
        : pageCopy.description,
    160,
  );
  const image = absoluteHttpUrl(
    isProduct ? product?.imageUrl : settings?.ogImageUrl || settings?.logoUrl,
    resolvedOrigin,
  );
  const keywords = cleanText(settings?.seoKeywords) || 'Zyro.lk, online marketplace Sri Lanka, online shopping Sri Lanka';
  const isPrivateCustomerPage = ['wishlist', 'recently-viewed', 'compare', 'payment-return'].includes(currentPage) || currentPage.startsWith('account');
  const robots = isAdminMode || isMissingPage || isPrivateCustomerPage ? 'noindex, follow' : 'index, follow';
  const socialLinks = [settings?.facebookUrl, settings?.instagramUrl, settings?.tiktokUrl, settings?.youtubeUrl]
    .map(value => absoluteHttpUrl(value, resolvedOrigin))
    .filter((value): value is string => Boolean(value));

  const organizationData: Record<string, unknown> = {
    '@type': 'Organization',
    '@id': `${resolvedOrigin}/#organization`,
    name: storeName,
    url: `${resolvedOrigin}/`,
    ...(image ? { logo: image } : {}),
    ...(settings?.contactPhone ? { telephone: settings.contactPhone } : {}),
    ...(settings?.contactEmail ? { email: settings.contactEmail } : {}),
    ...(socialLinks.length > 0 ? { sameAs: socialLinks } : {}),
  };

  const storeData: Record<string, unknown> = {
    '@type': 'OnlineStore',
    '@id': `${resolvedOrigin}/#store`,
    name: storeName,
    url: `${resolvedOrigin}/`,
    description,
    currenciesAccepted: 'LKR',
    parentOrganization: { '@id': `${resolvedOrigin}/#organization` },
    ...(image ? { logo: image } : {}),
    ...(settings?.contactPhone ? { telephone: settings.contactPhone } : {}),
    ...(settings?.contactEmail ? { email: settings.contactEmail } : {}),
    ...(socialLinks.length > 0 ? { sameAs: socialLinks } : {}),
  };

  const productData = isProduct && product ? {
    '@type': 'Product',
    '@id': `${canonical}#product`,
    name: productName,
    description,
    image: [image].filter(Boolean),
    mainEntityOfPage: canonical,
    ...(cleanText(product.sku) ? { sku: cleanText(product.sku) } : {}),
    category: cleanText(product.category),
    offers: {
      '@type': 'Offer',
      priceCurrency: 'LKR',
      price: Number(product.price),
      availability: product.isActive !== false && product.stock > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      url: canonical,
    },
    ...(product.reviewsCount > 0 && product.rating >= 1 && product.rating <= 5 ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: product.rating,
        reviewCount: product.reviewsCount,
      },
    } : {}),
  } : null;

  const breadcrumbData = isProduct && product ? {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${resolvedOrigin}/` },
      { '@type': 'ListItem', position: 2, name: productName, item: canonical },
    ],
  } : null;

  const websiteData: Record<string, unknown> = {
    '@type': 'WebSite',
    '@id': `${resolvedOrigin}/#website`,
    name: storeName,
    url: `${resolvedOrigin}/`,
    inLanguage: 'en-LK',
    publisher: { '@id': `${resolvedOrigin}/#organization` },
  };

  const structuredData: Record<string, unknown> = {
    '@context': 'https://schema.org',
    ...(productData || storeData),
    '@graph': [organizationData, websiteData, storeData, ...(breadcrumbData ? [breadcrumbData] : []), ...(productData ? [productData] : [])],
  };

  return {
    title: truncate(title, 68),
    description,
    keywords,
    siteName: storeName,
    locale: 'en_LK',
    image,
    imageAlt: isProduct ? productName : `${storeName} marketplace`,
    canonical,
    type: isProduct ? 'product' : 'website',
    robots,
    structuredData,
  };
};
