import { isSupplierProductLive } from "./supplierLowStockPolicy";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * Returns the persisted canonical-product references in authority order.
 * Embedded publication flags are intentionally not part of this identity.
 */
export const supplierReviewCanonicalProductIds = (value: unknown): string[] => {
  const record = asRecord(value);
  const payload = asRecord(record.productPayload);
  const comparison = asRecord(record.comparison);
  return [...new Set([
    record.canonicalProductId,
    record.productId,
    record.matchedProductId,
    comparison.matchedProductId,
    payload.id,
  ].map(text).filter(Boolean))];
};

export type SupplierReviewLiveProducts = ReadonlyMap<string, Record<string, unknown>>;

/**
 * A pending supplier review is live-equivalent only when one of its persisted
 * canonical references resolves to an existing product that is currently live.
 * Stale isActive/published/approved flags inside productPayload are advisory
 * and cannot establish live storefront state on their own.
 */
export const supplierReviewRecordIsLiveEquivalent = (
  value: unknown,
  liveProducts: SupplierReviewLiveProducts,
): boolean => {
  const linkedIds = supplierReviewCanonicalProductIds(value);
  return linkedIds.some((productId) => isSupplierProductLive(liveProducts.get(productId)));
};
