import type { Brand, Category, Product } from '../../types';
import { categoryMatches } from '../categories/categoryUtils';
import { isHttpUrl } from '../settings/storeSettingsValidation';
import {
  getActiveSubcategories,
  normalizeSpecificationTemplate,
  normalizeSubcategories,
} from './productBlueprint';

export interface ProductValidationInput {
  readonly product: Partial<Product>;
  readonly products: readonly Readonly<Product>[];
  readonly categories: readonly Readonly<Category>[];
  readonly brands?: readonly Readonly<Brand>[];
  readonly editingProductId?: string;
}

export const validateProductForSave = ({ product, products, categories, brands, editingProductId }: ProductValidationInput): readonly string[] => {
  const errors: string[] = [];
  if (!product.name?.trim()) errors.push('Product name is required.');
  if (!product.id?.trim()) errors.push('Product slug / ID cannot be empty.');

  const sellingPrice = Number(product.price);
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) errors.push('Sale price must be greater than zero.');
  if (product.originalPrice !== undefined && product.originalPrice !== null && Number(product.originalPrice) !== 0) {
    const regularPrice = Number(product.originalPrice);
    if (!Number.isFinite(regularPrice) || regularPrice <= 0) errors.push('Regular price must be greater than zero when provided.');
    else if (regularPrice < sellingPrice) errors.push('Regular price cannot be lower than the sale price.');
  }

  const stock = Number(product.stock);
  if (!Number.isInteger(stock) || stock < 0) errors.push('Stock must be a non-negative whole number.');

  const imageUrl = product.imageUrl?.trim() ?? '';
  if (!imageUrl) errors.push('Primary product image is required.');
  else if (!isHttpUrl(imageUrl)) errors.push('Primary product image must use a valid http or https URL.');
  if ((product.imageUrls ?? []).some((url) => !isHttpUrl(url))) {
    errors.push('Every gallery image must use a valid http or https URL.');
  }

  const category = categories.find((candidate) => categoryMatches(candidate.id, product.category ?? ''));
  if (!category) errors.push('Select an existing product category.');
  else {
    if (product.isActive !== false && category.isActive === false) errors.push('Published products must use an active category.');
    const subcategories = normalizeSubcategories(category.subcategories);
    const activeSubcategories = getActiveSubcategories(category);
    const selectedSubcategory = subcategories.find((candidate) => candidate.id === product.subcategory?.trim());
    if (activeSubcategories.length > 0 && !product.subcategory?.trim()) {
      errors.push('Select a sub category for the selected category.');
    } else if (product.subcategory?.trim() && !selectedSubcategory) {
      errors.push('Selected sub category does not belong to the selected category.');
    } else if (product.isActive !== false && selectedSubcategory?.isActive === false) {
      errors.push('Published products must use an active sub category.');
    }

    for (const field of normalizeSpecificationTemplate(category.specificationTemplate)) {
      if (field.required && !product.specs?.[field.name]?.trim()) {
        errors.push(`Required specification "${field.name}" must have a value.`);
      }
    }
  }

  if (brands !== undefined) {
    const selectedBrand = brands.find((brand) => brand.id === product.brand?.trim());
    if (!product.brand?.trim() || !selectedBrand) errors.push('Select an existing product brand.');
    else if (product.isActive !== false && selectedBrand.isActive === false) errors.push('Published products must use an active brand.');
  }

  if (product.barcode?.trim() && !/^\d{8,14}$/u.test(product.barcode.trim())) {
    errors.push('Barcode must contain 8 to 14 digits.');
  }

  const normalizedSku = product.sku?.trim().toLocaleLowerCase();
  if (!normalizedSku) errors.push('Product SKU is required.');
  else if (products.some((candidate) => candidate.id !== editingProductId && candidate.sku?.trim().toLocaleLowerCase() === normalizedSku)) {
    errors.push(`Product SKU "${product.sku?.trim()}" is already in use.`);
  }
  return errors;
};
