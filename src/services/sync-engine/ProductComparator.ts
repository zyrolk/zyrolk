import { Product } from '../../types';
import { InboundProduct, ProductComparisonResult, SyncConfig } from './types';
import { PriceComparator } from './PriceComparator';
import { ImageComparator } from './ImageComparator';
import { StockComparator } from './StockComparator';

export class ProductComparator {
  /**
   * Evaluates an inbound supplier product against the existing local database product.
   * Leverages specialized sub-comparators for prices, images, and inventory.
   * 
   * @param existing Local product from database, or undefined if it is a new insertion
   * @param inbound Ingress product record from supplier
   * @param config The active synchronization configurations
   */
  public static compare(
    existing: Product | undefined,
    inbound: InboundProduct,
    config: SyncConfig
  ): ProductComparisonResult {
    const defaultLimit = config.defaultImageLimit || 5;
    const defaultMarkup = config.defaultMarkup !== undefined ? config.defaultMarkup : 10;
    const defaultProfitMargin = config.defaultProfitMargin !== undefined ? config.defaultProfitMargin : 15;

    if (!existing) {
      // 1. New product ingestion pipeline
      const priceDetails = PriceComparator.compare(
        0, 
        inbound.costPrice, 
        0, 
        undefined, 
        defaultMarkup, 
        defaultProfitMargin
      );
      const imageDetails = ImageComparator.compare(
        undefined, 
        inbound.imageUrls, 
        defaultLimit
      );
      const stockDetails = StockComparator.compare(
        0, 
        inbound.stock
      );

      return {
        supplierItemCode: inbound.supplierItemCode,
        changeType: 'NEW_PRODUCT',
        hasChanges: true,
        priceDetails,
        imageDetails,
        stockDetails,
        descriptionChanged: true,
        oldDescription: '',
        newDescription: inbound.description,
        nameChanged: true,
        oldName: '',
        newName: inbound.name
      };
    }

    // 2. Existing product updates assessment pipeline
    const priceDetails = PriceComparator.compare(
      existing.costPrice || 0,
      inbound.costPrice,
      existing.price,
      existing.originalPrice,
      defaultMarkup,
      defaultProfitMargin
    );

    const imageDetails = ImageComparator.compare(
      existing.imageUrls,
      inbound.imageUrls,
      defaultLimit
    );

    const stockDetails = StockComparator.compare(
      existing.stock || 0,
      inbound.stock
    );

    const descriptionChanged = (existing.description || '').trim() !== (inbound.description || '').trim();
    const nameChanged = (existing.name || '').trim() !== (inbound.name || '').trim();

    // Determine primary change categorization
    let changeType: ProductComparisonResult['changeType'] = 'NONE';
    let hasChanges = false;

    if (priceDetails.hasChanged) {
      changeType = 'PRICE_CHANGED';
      hasChanges = true;
    } else if (stockDetails.hasChanged) {
      changeType = 'STOCK_CHANGED';
      hasChanges = true;
    } else if (imageDetails.hasChanged) {
      changeType = 'IMAGE_CHANGED';
      hasChanges = true;
    } else if (descriptionChanged || nameChanged) {
      changeType = 'DESCRIPTION_CHANGED';
      hasChanges = true;
    }

    return {
      productId: existing.id,
      supplierItemCode: inbound.supplierItemCode,
      changeType,
      hasChanges,
      priceDetails,
      imageDetails,
      stockDetails,
      descriptionChanged,
      oldDescription: existing.description,
      newDescription: inbound.description,
      nameChanged,
      oldName: existing.name,
      newName: inbound.name
    };
  }
}
