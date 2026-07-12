import type { Product } from '../../types';
import { getProductBrand, getProductModel, normalizeSearchText } from './productSearchMetadata';

export const searchAdminProducts = <T extends Readonly<Product>>(
  products: readonly T[],
  query: string,
): readonly T[] => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return products;

  return products.filter((product) => {
    const rawProduct = product as Readonly<Product> & Readonly<Record<string, unknown>>;
    return [
      product.name,
      rawProduct.supplierCode,
      product.supplierItemCode,
      product.sku,
      getProductBrand(product),
      getProductModel(product),
      product.category,
    ].some((value) => normalizeSearchText(value).includes(normalizedQuery));
  });
};
