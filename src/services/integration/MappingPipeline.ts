import { RawA2ZProduct } from '../connectors/a2z-website/types';
import { InboundProduct } from '../sync-engine/types';
import { ProductMapper } from '../connectors/a2z-website/ProductMapper';

export class MappingPipeline {
  /**
   * Maps a single Raw A2Z Product to the standardized InboundProduct model.
   */
  public static async mapProduct(raw: RawA2ZProduct): Promise<InboundProduct> {
    return ProductMapper.mapToInbound(raw);
  }

  /**
   * Maps a batch of Raw A2Z Products to standardized InboundProduct models.
   */
  public static async mapCatalog(rawItems: RawA2ZProduct[]): Promise<InboundProduct[]> {
    return rawItems.map(item => ProductMapper.mapToInbound(item));
  }
}
