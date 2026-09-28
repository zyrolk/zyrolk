import type { CartItem, Product } from '../../types';

/**
 * The Firestore web SDK rejects `undefined` field values (invalid-argument) unless
 * `ignoreUndefinedProperties` is enabled, and storefront product projections keep
 * absent optional fields as explicit `undefined` keys. Only those top-level keys
 * are omitted; every other value, including falsy ones, is copied unchanged.
 */
export function toFirestoreCartItem(item: CartItem): CartItem {
  const product = Object.fromEntries(
    Object.entries(item.product).filter(([, value]) => value !== undefined),
  ) as unknown as Product;
  return { ...item, product };
}

export function toFirestoreCartSnapshot(items: readonly CartItem[]): CartItem[] {
  return items.map(toFirestoreCartItem);
}
