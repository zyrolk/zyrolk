/** Public catalogue availability: only explicit boolean true is active. */
export const isProductExplicitlyActive = (value: unknown): boolean => value === true;

/**
 * Normalizes public catalogue stock before it is used for customer-facing
 * availability decisions.
 */
export const normalizeStorefrontStock = (value: unknown): number => {
  let resolved: number;
  try {
    resolved = Number(value);
  } catch {
    return 0;
  }
  return Number.isFinite(resolved) ? Math.max(0, Math.trunc(resolved)) : 0;
};

/** Homepage shelves only show products that can currently be purchased. */
export const isProductInStock = (
  product: Readonly<{ stock?: unknown }> | null | undefined,
): boolean => normalizeStorefrontStock(product?.stock) > 0;
