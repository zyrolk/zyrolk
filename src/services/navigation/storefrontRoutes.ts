const PAGE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  home: '/',
  'legacy-home': '/',
  products: '/products',
  categories: '/categories',
  wishlist: '/wishlist',
  'recently-viewed': '/recently-viewed',
  compare: '/compare',
  contact: '/contact',
  account: '/account',
  'account-orders': '/account/orders',
  'account-order-details': '/account/orders/details',
  'account-profile': '/account/profile',
  'account-addresses': '/account/addresses',
  'account-security': '/account/security',
  'account-settings': '/account/settings',
  'about-us': '/about-us',
  'privacy-policy': '/privacy-policy',
  'terms-conditions': '/terms-conditions',
  'return-policy': '/return-policy',
  'warranty-policy': '/warranty-policy',
  faq: '/faq',
  admin: '/admin',
});

const PATH_PAGES = new Map(Object.entries(PAGE_PATHS)
  .filter(([page]) => page !== 'legacy-home')
  .map(([page, path]) => [path, page]));

const normalizePath = (pathname: string): string => {
  const path = pathname.trim().replace(/\/{2,}/gu, '/');
  if (!path || path === '/') return '/';
  return `/${path.replace(/^\/+|\/+$/gu, '')}`;
};

const decodeSegment = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && decoded.length <= 240 ? decoded : undefined;
  } catch {
    return undefined;
  }
};

export interface StorefrontRoute {
  page: string;
  categoryId?: string;
  productId?: string;
  searchQuery?: string;
  listingMode?: StorefrontListingMode;
}

export interface StorefrontUrlState extends StorefrontRoute {
  productId?: string | null;
}

export type StorefrontListingMode = 'new-arrivals' | 'best-sellers';

const parseListingMode = (value: string | null): StorefrontListingMode | undefined => (
  value === 'new-arrivals' || value === 'best-sellers' ? value : undefined
);

export const parseStorefrontRoute = (pathname: string, search = ''): StorefrontRoute => {
  const path = normalizePath(pathname);
  const params = new URLSearchParams(search);
  const legacyProductId = decodeSegment(params.get('product') || undefined);
  if (legacyProductId) return { page: 'products', productId: legacyProductId };

  const productMatch = path.match(/^\/products\/([^/]+)$/u);
  if (productMatch) {
    const productId = decodeSegment(productMatch[1]);
    return productId ? { page: 'products', productId } : { page: 'not-found' };
  }

  const categoryMatch = path.match(/^\/categories\/([^/]+)$/u);
  if (categoryMatch) {
    const categoryId = decodeSegment(categoryMatch[1]);
    return categoryId ? { page: 'products', categoryId } : { page: 'not-found' };
  }

  if (path === '/search') {
    const searchQuery = params.get('q')?.trim().slice(0, 160) || undefined;
    return { page: 'products', searchQuery };
  }

  const page = PATH_PAGES.get(path) || 'not-found';
  return page === 'products'
    ? { page, listingMode: parseListingMode(params.get('view')) }
    : { page };
};

export const buildStorefrontUrl = ({ page, categoryId, productId, searchQuery, listingMode }: StorefrontUrlState): string => {
  const cleanProductId = productId?.trim();
  if (cleanProductId) return `/products/${encodeURIComponent(cleanProductId)}`;

  if (page === 'products') {
    const cleanCategoryId = categoryId?.trim();
    if (cleanCategoryId && cleanCategoryId !== 'all') return `/categories/${encodeURIComponent(cleanCategoryId)}`;
    const cleanSearchQuery = searchQuery?.trim();
    if (cleanSearchQuery) return `/search?q=${encodeURIComponent(cleanSearchQuery)}`;
    if (listingMode === 'new-arrivals' || listingMode === 'best-sellers') {
      return `/products?view=${encodeURIComponent(listingMode)}`;
    }
  }

  return PAGE_PATHS[page] || '/not-found';
};

export const absoluteStorefrontUrl = (origin: string, state: StorefrontUrlState): string => (
  new URL(buildStorefrontUrl(state), `${origin}/`).toString()
);
