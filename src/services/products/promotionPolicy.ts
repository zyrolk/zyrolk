import type { Product } from '../../types';

export const MAX_PROMOTION_DISCOUNT_PERCENT = 20;
export const PROMOTION_DISCOUNT_CAP_MESSAGE = 'Launch promotions cannot exceed 20%.';

// Absorbs binary floating-point error so an exact 20% promotion is never rejected.
const DISCOUNT_PERCENT_TOLERANCE = 1e-9;

export interface CustomerPromotion {
  readonly originalPrice: number;
  readonly discountPercent: number;
}

/** Exact discount percentage, or undefined when the prices do not form a valid promotion. */
export const calculatePromotionDiscountPercent = (originalPrice: unknown, price: unknown): number | undefined => {
  if (originalPrice === null || originalPrice === undefined || price === null || price === undefined) return undefined;
  const regular = Number(originalPrice);
  const selling = Number(price);
  if (!Number.isFinite(regular) || !Number.isFinite(selling) || selling <= 0 || regular <= selling) return undefined;
  return ((regular - selling) * 100) / regular;
};

/** True only for a structurally valid promotion whose discount is above the cap. */
export const exceedsPromotionDiscountCap = (originalPrice: unknown, price: unknown): boolean => {
  const percent = calculatePromotionDiscountPercent(originalPrice, price);
  return percent !== undefined && percent > MAX_PROMOTION_DISCOUNT_PERCENT + DISCOUNT_PERCENT_TOLERANCE;
};

/**
 * The customer-visible promotion for a product, derived from its live prices.
 * Invalid, disabled, or over-cap promotions resolve to null so the storefront
 * shows the normal selling price only.
 */
export const resolveCustomerPromotion = (
  product: Pick<Product, 'price' | 'originalPrice' | 'promotionEnabled'>,
): CustomerPromotion | null => {
  if (product.promotionEnabled === false) return null;
  const percent = calculatePromotionDiscountPercent(product.originalPrice, product.price);
  if (percent === undefined || percent > MAX_PROMOTION_DISCOUNT_PERCENT + DISCOUNT_PERCENT_TOLERANCE) return null;
  const discountPercent = Math.round(percent);
  if (discountPercent <= 0) return null;
  return { originalPrice: Number(product.originalPrice), discountPercent };
};
