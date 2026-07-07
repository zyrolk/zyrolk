import { Product } from '../../types';
import { InboundProduct, ProductComparisonResult, SyncConfig } from '../sync-engine/types';
import { ProductComparator } from '../sync-engine/ProductComparator';

export class ComparisonPipeline {
  /**
   * Evaluates the difference between an incoming product and an optional existing catalog item.
   */
  public static async compareProduct(
    existing: Product | undefined,
    inbound: InboundProduct,
    config: SyncConfig
  ): Promise<ProductComparisonResult> {
    return ProductComparator.compare(existing, inbound, config);
  }

  /**
   * Processes comparisons for a batch of inbound products against an existing inventory map.
   * Resolves O(1) matching via pre-mapped dictionary lookup.
   */
  public static async compareCatalog(
    existingProductMap: Map<string, Product>,
    inboundItems: InboundProduct[],
    config: SyncConfig
  ): Promise<ProductComparisonResult[]> {
    const results: ProductComparisonResult[] = [];

    for (const inbound of inboundItems) {
      const existing = existingProductMap.get(inbound.supplierItemCode);
      const result = ProductComparator.compare(existing, inbound, config);
      results.push(result);
    }

    return results;
  }
}
