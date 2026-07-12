import type { Product } from '../../types';

export const normalizeSearchText = (value: unknown): string =>
  typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
    : '';

const readSpecification = (product: Pick<Product, 'specs'>, key: 'brand' | 'model'): string => {
  const entry = Object.entries(product.specs ?? {}).find(
    ([specification]) => normalizeSearchText(specification) === key,
  );
  return typeof entry?.[1] === 'string' ? entry[1].trim() : '';
};

export const getProductBrand = (product: Pick<Product, 'specs'>): string =>
  readSpecification(product, 'brand');

export const getProductModel = (product: Pick<Product, 'specs'>): string =>
  readSpecification(product, 'model');
