import { RawA2ZProduct, ValidationResult } from './types';
import { InboundProduct } from '../../sync-engine/types';

export class ProductValidator {
  /**
   * Validates raw supplier data structures to ensure essential scraping nodes are complete.
   */
  public static validateRaw(product: RawA2ZProduct): ValidationResult {
    const errors: string[] = [];

    if (!product.sku || product.sku.trim() === '') {
      errors.push('Supplier SKU (sku) is missing or blank.');
    }
    if (!product.title || product.title.trim() === '') {
      errors.push('Product title is missing or blank.');
    }
    if (product.wholesalePrice === undefined || product.wholesalePrice < 0) {
      errors.push('Wholesale cost price is invalid or negative.');
    }
    if (product.inventoryLevel === undefined || product.inventoryLevel < 0) {
      errors.push('Inventory stock count is invalid or negative.');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validates target mapped InboundProduct structure to guarantee safety before sync pipeline execution.
   */
  public static validateMapped(product: InboundProduct): ValidationResult {
    const errors: string[] = [];

    if (!product.supplierItemCode || product.supplierItemCode.trim() === '') {
      errors.push('Mapped supplierItemCode is missing.');
    }
    if (!product.name || product.name.trim() === '') {
      errors.push('Mapped name is empty.');
    }
    if (!product.description || product.description.trim() === '') {
      errors.push('Mapped description is empty.');
    }
    if (product.costPrice === undefined || product.costPrice <= 0) {
      errors.push('Mapped costPrice must be a positive non-zero value.');
    }
    if (product.stock === undefined || product.stock < 0) {
      errors.push('Mapped stock count cannot be negative.');
    }
    if (!product.category || product.category.trim() === '') {
      errors.push('Mapped primary category is empty.');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
