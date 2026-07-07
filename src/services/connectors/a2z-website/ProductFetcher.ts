import { RawA2ZProduct, FetchOptions } from './types';
import { ConnectorLogger } from './ConnectorLogger';
import { A2ZConnectorService } from './A2ZConnectorService';

export class ProductFetcher {
  /**
   * Models fetching a single product catalog element by its identifier (Supplier Code).
   * Executes live HTTP fetch via the A2ZConnectorService and extracts the matching SKU.
   */
  public static async fetchBySupplierCode(
    supplierCode: string,
    connectorUrl: string = 'https://api.zyro.lk/v1/supplier/a2z'
  ): Promise<RawA2ZProduct | null> {
    await ConnectorLogger.log('info', 'ProductFetcher', `Preparing fetch request for SKU: ${supplierCode}`, {
      endpoint: `${connectorUrl}/product/${supplierCode}`
    });

    try {
      const catalog = await this.fetchCatalogIndex(connectorUrl);
      const match = catalog.find(p => p.sku.trim().toLowerCase() === supplierCode.trim().toLowerCase());
      return match || null;
    } catch (err: any) {
      await ConnectorLogger.log('error', 'ProductFetcher', `Fetch by supplier code failed for SKU ${supplierCode}: ${err.message || err}`);
      return null;
    }
  }

  /**
   * Pulls the complete product index list based on query parameters.
   * Executes live HTTP fetch via the authenticated A2ZConnectorService.
   */
  public static async fetchCatalogIndex(
    connectorUrl: string = 'https://api.zyro.lk/v1/supplier/a2z',
    options: FetchOptions = {}
  ): Promise<RawA2ZProduct[]> {
    await ConnectorLogger.log('info', 'ProductFetcher', 'Preparing paginated catalog fetch request', {
      endpoint: `${connectorUrl}/catalog`,
      options
    });

    try {
      const products = await A2ZConnectorService.fetchCatalog(connectorUrl, {});
      return products;
    } catch (err: any) {
      await ConnectorLogger.log('error', 'ProductFetcher', `Catalog index fetch failed: ${err.message || err}`);
      throw err;
    }
  }
}
