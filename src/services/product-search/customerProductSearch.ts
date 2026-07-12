import type { CustomerProduct } from '../../types';
import { normalizeSearchText } from './productSearchMetadata';

export const searchCustomerProducts = (
  products: readonly CustomerProduct[],
  query: string,
): readonly CustomerProduct[] => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return products;

  return products.filter((product) => [
    product.name,
    product.brand,
    product.model,
    product.category,
  ].some((value) => normalizeSearchText(value).includes(normalizedQuery)));
};
