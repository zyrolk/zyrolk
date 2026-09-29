import type { Product } from '../../types';

/**
 * The Firestore web SDK rejects `undefined` field values (invalid-argument) unless
 * `ignoreUndefinedProperties` is enabled, and storefront product projections keep
 * absent optional fields as explicit `undefined` keys. Only those top-level keys
 * are omitted; every other value, including falsy ones, is copied unchanged.
 */
export function toFirestoreWishlistProduct(product: Product): Product {
  return Object.fromEntries(
    Object.entries(product).filter(([, value]) => value !== undefined),
  ) as unknown as Product;
}

export function toFirestoreWishlistSnapshot(products: readonly Product[]): Product[] {
  return products.map(toFirestoreWishlistProduct);
}
