import type { CartItem, Product } from '../../types';

/**
 * Reserved namespace for local-only homepage presentation examples.
 *
 * Preview content is not a Product document and must never cross a commerce
 * boundary. Keeping the namespace explicit also prevents a future preview
 * card from accidentally becoming a cart or checkout item.
 */
export const PREVIEW_PRODUCT_ID_PREFIX = 'preview:';

export function isPreviewProductId(productId: unknown): productId is string {
  return typeof productId === 'string' && productId.startsWith(PREVIEW_PRODUCT_ID_PREFIX);
}

export function canUseProductInCommerce(product: Pick<Product, 'id'> | null | undefined): boolean {
  return Boolean(product && !isPreviewProductId(product.id));
}

export function filterCommerceCartItems(items: readonly CartItem[]): CartItem[] {
  return items.filter((item) => canUseProductInCommerce(item?.product));
}

export function filterCommerceProducts(products: readonly Product[]): Product[] {
  return products.filter((product) => canUseProductInCommerce(product));
}

export function filterCommerceProductIds(productIds: readonly string[]): string[] {
  return productIds.filter((productId) => !isPreviewProductId(productId));
}
