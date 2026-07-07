import { RawA2ZProduct } from './types';
import { InboundProduct } from '../../sync-engine/types';

export class ProductMapper {
  /**
   * Transforms raw scraped or parsed supplier payload structures into standard Zyro.lk comparison models.
   */
  public static mapToInbound(raw: RawA2ZProduct): InboundProduct {
    // Extract primary category from hierarchical array, default to 'Uncategorized' if empty
    let primaryCategory = 'Uncategorized';
    if (raw.categoryHierarchy && raw.categoryHierarchy.length > 0) {
      primaryCategory = raw.categoryHierarchy[raw.categoryHierarchy.length - 1];
    }

    return {
      supplierItemCode: raw.sku.trim(),
      name: raw.title.trim(),
      description: raw.longDescription ? raw.longDescription.trim() : '',
      costPrice: Number(raw.wholesalePrice) || 0,
      stock: Math.max(0, Number(raw.inventoryLevel)) || 0,
      category: primaryCategory,
      imageUrls: raw.mediaGallery ? raw.mediaGallery.map(url => url.trim()) : [],
      specs: raw.specifications || {}
    };
  }
}
