export type StorefrontCatalogStatus = 'loading' | 'ready' | 'empty' | 'error' | 'timeout';

export function catalogStatusFromProductPage(productCount: number): StorefrontCatalogStatus {
  return productCount > 0 ? 'ready' : 'empty';
}

export function shouldShowCatalogFallback(
  status: StorefrontCatalogStatus,
  loading: boolean,
  hasLiveProducts: boolean,
): boolean {
  return !loading
    && !hasLiveProducts
    && (status === 'empty' || status === 'error' || status === 'timeout');
}
