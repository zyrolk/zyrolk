import { RawA2ZProduct } from './types';
import { ConnectorLogger } from './ConnectorLogger';
import { buildA2ZProductImageUrl, extractA2ZProductImages } from './productImages';

export { extractA2ZProductImages } from './productImages';

export class ProductParser {
  /**
   * Parses a raw JSON string or object payload ingested from the A2Z Web Feed.
   * Securely extracts:
   * 1. SKU (Supplier Code)
   * 2. Title (Product Name)
   * 3. Description
   * 4. Media Gallery (Images)
   * 5. Wholesale Price (Cost Price)
   * 6. Recommended Retail Price (Market Price)
   * 7. Inventory Level (Stock count)
   */
  public static parseJsonPayload(rawPayload: string | Record<string, any>, baseUrl = 'https://a2zdropshipping.lk'): RawA2ZProduct {
    let rawObj: Record<string, any>;

    if (typeof rawPayload === 'string') {
      try {
        rawObj = JSON.parse(rawPayload);
      } catch (error) {
        ConnectorLogger.log('error', 'ProductParser', 'Failed to parse raw JSON feed string.', { error: String(error) });
        throw new Error('Invalid JSON format for product payload ingestion.');
      }
    } else {
      rawObj = rawPayload;
    }

    // Extraction with robust fallback checks
    const sku = String(rawObj.pro_code || rawObj.sku || rawObj.supplier_code || rawObj.pro_id || rawObj.id || '').trim();
    const title = String(rawObj.pro_name || rawObj.title || rawObj.name || rawObj.product_name || '').trim();
    const longDescription = String(rawObj.pro_desc || rawObj.longDescription || rawObj.description || rawObj.details || '').trim();
    
    const extractedImages = extractA2ZProductImages(rawObj, baseUrl);
    const canonicalImage = buildA2ZProductImageUrl(rawObj.pro_id);
    const mediaGallery = [...new Set([
      ...extractedImages,
      ...(canonicalImage ? [canonicalImage] : []),
    ])];

    const wholesalePrice = Number(rawObj.wholesale_price || rawObj.wholesalePrice || rawObj.costPrice || rawObj.cost_price || rawObj.supplier_price || 0);
    const recommendedRetailPrice = Number(rawObj.website_price || rawObj.price_min || rawObj.price_max || rawObj.recommendedRetailPrice || rawObj.marketPrice || rawObj.retail_price || rawObj.selling_price || 0);
    const inventoryLevel = Number(rawObj.bal !== undefined && rawObj.bal !== null ? rawObj.bal : (rawObj.inventoryLevel !== undefined ? rawObj.inventoryLevel : (rawObj.stock || rawObj.quantity || 0)));

    // Optional attributes
    const categoryHierarchy = rawObj.cat_name ? [String(rawObj.cat_name)] : (Array.isArray(rawObj.categoryHierarchy) ? rawObj.categoryHierarchy.map(String) : []);
    const specifications = typeof rawObj.specifications === 'object' && rawObj.specifications !== null ? rawObj.specifications : {};

    return {
      sku,
      title,
      longDescription,
      mediaGallery,
      wholesalePrice,
      recommendedRetailPrice,
      inventoryLevel,
      categoryHierarchy,
      specifications
    };
  }

  /**
   * Helper utility to safely extract specifications or metadata from unstructured description layouts.
   */
  public static extractRegexSpec(description: string, specName: string): string | null {
    const escapedName = specName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`${escapedName}\\s*:\\s*([^\\n\\r]+)`, 'i');
    const match = description.match(regex);
    return match ? match[1].trim() : null;
  }
}
