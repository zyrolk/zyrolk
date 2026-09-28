export const MAX_PROMOTION_DISCOUNT_PERCENT = 20;
export const PROMOTION_DISCOUNT_CAP_MESSAGE = "Launch promotions cannot exceed 20%.";

// Absorbs binary floating-point error so an exact 20% promotion is never rejected.
const DISCOUNT_PERCENT_TOLERANCE = 1e-9;

/** Exact discount percentage, or undefined when the prices do not form a valid promotion. */
export function calculatePromotionDiscountPercent(originalPrice: unknown, price: unknown): number | undefined {
  if (originalPrice === null || originalPrice === undefined || price === null || price === undefined) return undefined;
  const regular = Number(originalPrice);
  const selling = Number(price);
  if (!Number.isFinite(regular) || !Number.isFinite(selling) || selling <= 0 || regular <= selling) return undefined;
  return ((regular - selling) * 100) / regular;
}

export function isPromotionDiscountWithinCap(originalPrice: unknown, price: unknown): boolean {
  const percent = calculatePromotionDiscountPercent(originalPrice, price);
  return percent !== undefined && percent <= MAX_PROMOTION_DISCOUNT_PERCENT + DISCOUNT_PERCENT_TOLERANCE;
}

/** True only for a structurally valid promotion whose discount is above the cap. */
export function exceedsPromotionDiscountCap(originalPrice: unknown, price: unknown): boolean {
  const percent = calculatePromotionDiscountPercent(originalPrice, price);
  return percent !== undefined && percent > MAX_PROMOTION_DISCOUNT_PERCENT + DISCOUNT_PERCENT_TOLERANCE;
}
