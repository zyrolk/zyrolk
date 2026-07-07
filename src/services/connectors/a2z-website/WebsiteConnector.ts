import { RawA2ZProduct, FetchOptions } from './types';
import { InboundProduct } from '../../sync-engine/types';
import { ProductFetcher } from './ProductFetcher';
import { ProductParser } from './ProductParser';
import { ProductValidator } from './ProductValidator';
import { ProductMapper } from './ProductMapper';
import { ImageDownloader } from './ImageDownloader';
import { ConnectorLogger } from './ConnectorLogger';

export class WebsiteConnector {
  /**
   * Orchestrates the retrieval, parsing, mapping, validation, and preparing of a single product
   * for the down-stream Sync Engine.
   * 
   * @param sku The supplier code/sku of the target product
   * @param connectorUrl The URL of the supplier source node
   */
  public static async ingestProductByCode(
    sku: string,
    connectorUrl?: string
  ): Promise<InboundProduct | null> {
    await ConnectorLogger.log('info', 'WebsiteConnector', `Ingestion routine initiated for sku: ${sku}`);

    try {
      // 1. Fetch raw product data representation
      const rawProduct = await ProductFetcher.fetchBySupplierCode(sku, connectorUrl);
      if (!rawProduct) {
        await ConnectorLogger.log('warn', 'WebsiteConnector', `Ingestion routine aborted: SKU ${sku} not found`);
        return null;
      }

      // 2. Parse payload properties
      const parsedProduct = ProductParser.parseJsonPayload(rawProduct);

      // 3. Validate raw data
      const validation = ProductValidator.validateRaw(parsedProduct);
      if (!validation.isValid) {
        await ConnectorLogger.log('error', 'WebsiteConnector', `Raw validation failure for SKU ${sku}`, {
          errors: validation.errors
        });
        return null;
      }

      // 4. Map raw product to standardized InboundProduct schema
      const mappedInbound = ProductMapper.mapToInbound(parsedProduct);

      // 5. Validate mapped data integrity
      const mappedValidation = ProductValidator.validateMapped(mappedInbound);
      if (!mappedValidation.isValid) {
        await ConnectorLogger.log('error', 'WebsiteConnector', `Mapped validation failure for SKU ${sku}`, {
          errors: mappedValidation.errors
        });
        return null;
      }

      await ConnectorLogger.log('info', 'WebsiteConnector', `Product successfully mapped for sync comparison: ${sku}`);
      return mappedInbound;

    } catch (error) {
      await ConnectorLogger.log('error', 'WebsiteConnector', `Ingestion routine failed for SKU ${sku}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Orchestrates batch ingestion processing of the supplier's web catalog.
   * Returns a clean, comparison-ready array of InboundProducts for the Sync Engine.
   */
  public static async ingestCatalog(
    connectorUrl?: string,
    options?: FetchOptions
  ): Promise<InboundProduct[]> {
    await ConnectorLogger.log('info', 'WebsiteConnector', 'Batch ingestion routine initiated for catalog feed');

    try {
      // 1. Fetch the raw products collection
      const rawProducts = await ProductFetcher.fetchCatalogIndex(connectorUrl, options);
      const readyProducts: InboundProduct[] = [];

      // 2. Standardize, validate, and convert each item
      for (const raw of rawProducts) {
        try {
          const parsed = ProductParser.parseJsonPayload(raw);
          const validation = ProductValidator.validateRaw(parsed);
          
          if (!validation.isValid) {
            await ConnectorLogger.log('warn', 'WebsiteConnector', `Batch item ${parsed.sku} failed validation, skipped.`, {
              errors: validation.errors
            });
            continue;
          }

          const mapped = ProductMapper.mapToInbound(parsed);
          const mappedValidation = ProductValidator.validateMapped(mapped);

          if (!mappedValidation.isValid) {
            await ConnectorLogger.log('warn', 'WebsiteConnector', `Batch item mapped format invalid for ${mapped.supplierItemCode}, skipped.`, {
              errors: mappedValidation.errors
            });
            continue;
          }

          readyProducts.push(mapped);
        } catch (itemError) {
          await ConnectorLogger.log('error', 'WebsiteConnector', 'Error processing batch catalog item', {
            error: itemError instanceof Error ? itemError.message : String(itemError)
          });
        }
      }

      await ConnectorLogger.log('info', 'WebsiteConnector', `Catalog batch ingestion complete. Retrieved ${readyProducts.length} comparison-ready products.`);
      return readyProducts;

    } catch (error) {
      await ConnectorLogger.log('error', 'WebsiteConnector', 'Catalog batch ingestion aborted due to critical fetch error.', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
}
