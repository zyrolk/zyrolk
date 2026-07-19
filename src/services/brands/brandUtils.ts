import type { Brand, Product } from '../../types';
import { normalizeCategorySlug } from '../categories/categoryUtils';
import { normalizeSearchText } from '../product-search/productSearchMetadata';

export const normalizeBrandName = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

export const normalizeBrandId = (value: string): string => normalizeCategorySlug(value);

export const sortBrandsAlphabetically = <T extends Readonly<Brand>>(brands: readonly T[]): T[] =>
  brands
    .map((brand, index) => ({ brand, index }))
    .sort((left, right) => (
      normalizeBrandName(left.brand.name).localeCompare(
        normalizeBrandName(right.brand.name),
        'en',
        { sensitivity: 'base', numeric: true },
      ) || left.index - right.index
    ))
    .map(({ brand }) => brand);

export const isDuplicateBrand = (
  brands: readonly Readonly<Brand>[],
  id: string,
  name: string,
  editingBrandId?: string,
): boolean => {
  const normalizedId = normalizeBrandId(id);
  const normalizedName = normalizeSearchText(name);
  return brands.some((brand) => (
    brand.id !== editingBrandId
    && (normalizeBrandId(brand.id) === normalizedId || normalizeSearchText(brand.name) === normalizedName)
  ));
};

export const productReferencesBrand = (
  product: Readonly<Product>,
  brand: Readonly<Brand>,
): boolean => {
  const storedBrand = normalizeSearchText(product.brand);
  if (storedBrand && (storedBrand === normalizeSearchText(brand.id) || storedBrand === normalizeSearchText(brand.name))) {
    return true;
  }
  const legacyBrand = Object.entries(product.specs ?? {}).find(
    ([key]) => normalizeSearchText(key) === 'brand',
  )?.[1];
  return normalizeSearchText(legacyBrand) === normalizeSearchText(brand.name);
};

export const countProductsForBrand = (
  products: readonly Readonly<Product>[],
  brand: Readonly<Brand>,
): number => products.filter((product) => productReferencesBrand(product, brand)).length;

export const resolveRegisteredBrandId = (
  product: Pick<Product, 'brand' | 'specs'>,
  brands: readonly Readonly<Brand>[],
): string => {
  const candidateValues = [
    product.brand,
    Object.entries(product.specs ?? {}).find(([key]) => normalizeSearchText(key) === 'brand')?.[1],
  ].map(normalizeSearchText).filter(Boolean);

  const match = brands.find((brand) => candidateValues.some((candidate) => (
    candidate === normalizeSearchText(brand.id) || candidate === normalizeSearchText(brand.name)
  )));
  return match?.id ?? '';
};
