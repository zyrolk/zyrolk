import { RawA2ZProduct, ValidationResult } from '../connectors/a2z-website/types';
import { InboundProduct } from '../sync-engine/types';
import { ProductValidator } from '../connectors/a2z-website/ProductValidator';

export class ValidationPipeline {
  /**
   * Validates a raw supplier product payload from the ingestion feed.
   */
  public static async validateRawProduct(raw: RawA2ZProduct): Promise<ValidationResult> {
    return ProductValidator.validateRaw(raw);
  }

  /**
   * Validates a list of raw supplier product payloads. Returns only the valid items.
   * Logs or gathers validation errors for failed items.
   */
  public static async validateRawCatalog(rawItems: RawA2ZProduct[]): Promise<{
    validItems: RawA2ZProduct[];
    invalidItems: { product: RawA2ZProduct; errors: string[] }[];
  }> {
    const validItems: RawA2ZProduct[] = [];
    const invalidItems: { product: RawA2ZProduct; errors: string[] }[] = [];

    for (const item of rawItems) {
      const result = ProductValidator.validateRaw(item);
      if (result.isValid) {
        validItems.push(item);
      } else {
        invalidItems.push({ product: item, errors: result.errors });
      }
    }

    return { validItems, invalidItems };
  }

  /**
   * Validates a mapped inbound product model before syncing.
   */
  public static async validateMappedProduct(mapped: InboundProduct): Promise<ValidationResult> {
    return ProductValidator.validateMapped(mapped);
  }

  /**
   * Validates a batch of mapped inbound product models.
   */
  public static async validateMappedCatalog(mappedItems: InboundProduct[]): Promise<{
    validItems: InboundProduct[];
    invalidItems: { product: InboundProduct; errors: string[] }[];
  }> {
    const validItems: InboundProduct[] = [];
    const invalidItems: { product: InboundProduct; errors: string[] }[] = [];

    for (const item of mappedItems) {
      const result = ProductValidator.validateMapped(item);
      if (result.isValid) {
        validItems.push(item);
      } else {
        invalidItems.push({ product: item, errors: result.errors });
      }
    }

    return { validItems, invalidItems };
  }
}
