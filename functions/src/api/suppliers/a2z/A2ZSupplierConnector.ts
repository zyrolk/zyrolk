import { A2ZConnectorService } from "./A2ZConnectorService";
import { getA2ZCredentials } from "../credentials";
import { SupplierCatalogPageRequest, SupplierCatalogPageResult, SupplierConnectionTestResult, SupplierConnector, SupplierConnectorType, SupplierFetchResult } from "../types";
import { SupplierOutboundPolicy } from "../../security/supplierOutboundRequest";

export class A2ZSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly connectorType: SupplierConnectorType;
  public readonly enabled: boolean;
  public readonly priority: number;
  public readonly capabilities: readonly string[];
  private readonly outboundPolicy: SupplierOutboundPolicy;

  constructor(
    private readonly targetUrl: string,
    options: {
      id?: string;
      name?: string;
      connectorType?: SupplierConnectorType;
      enabled?: boolean;
      priority?: number;
      capabilities?: readonly string[];
      outboundPolicy: SupplierOutboundPolicy;
    },
  ) {
    this.id = options.id || "a2z";
    this.name = options.name || "A2Z Supplier";
    this.connectorType = options.connectorType || "a2z";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
    this.capabilities = options.capabilities || ["catalog.fetch", "connection.test", "inventory.read"];
    this.outboundPolicy = options.outboundPolicy;
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const credentials = await getA2ZCredentials(this.id);
    const products = await A2ZConnectorService.fetchCatalog(this.targetUrl, credentials, this.outboundPolicy);
    return {
      products,
      targetUrl: this.targetUrl,
    };
  }

  public async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    const credentials = await getA2ZCredentials(this.id);
    return A2ZConnectorService.fetchCatalogPage(this.targetUrl, credentials, this.outboundPolicy, request);
  }

  public async testConnection(): Promise<SupplierConnectionTestResult> {
    try {
      const result = await this.fetchProducts();
      return {
        success: true,
        status: "Connected",
        productsCount: result.products.length,
        sampleProduct: result.products[0] || null,
      };
    } catch (error: any) {
      return {
        success: false,
        status: "Failed",
        productsCount: 0,
        sampleProduct: null,
        error: error.message || "Authentication or fetch failed with A2Z supplier.",
      };
    }
  }
}
