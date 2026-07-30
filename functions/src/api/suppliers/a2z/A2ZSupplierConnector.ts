import { A2ZConnectorService } from "./A2ZConnectorService";
import { getA2ZCredentials } from "../credentials";
import { SupplierCatalogPageRequest, SupplierCatalogPageResult, SupplierConnectionTestResult, SupplierConnector, SupplierConnectorType, SupplierFetchResult } from "../types";
import { SupplierOutboundPolicy } from "../../security/supplierOutboundRequest";

export const DEFAULT_A2Z_CREDENTIAL_REFERENCE = "firebase-secret-manager:A2Z_USERNAME+A2Z_PASSWORD";

export class A2ZSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly connectorType: SupplierConnectorType;
  public readonly enabled: boolean;
  public readonly priority: number;
  public readonly capabilities: readonly string[];
  private readonly outboundPolicy: SupplierOutboundPolicy;
  private readonly connectorService: A2ZConnectorService;

  constructor(
    private readonly targetUrl: string,
    options: {
      id?: string;
      supplierId?: string;
      sourceId?: string;
      name?: string;
      connectorType?: SupplierConnectorType;
      enabled?: boolean;
      priority?: number;
      capabilities?: readonly string[];
      credentialReference?: string;
      outboundPolicy: SupplierOutboundPolicy;
    },
  ) {
    this.id = options.sourceId || options.id || "a2z";
    this.name = options.name || "A2Z Supplier";
    this.connectorType = options.connectorType || "a2z";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
    this.capabilities = options.capabilities || ["catalog.fetch", "connection.test", "inventory.read"];
    this.outboundPolicy = options.outboundPolicy;
    this.connectorService = new A2ZConnectorService({
      supplierId: options.supplierId || this.id,
      sourceId: this.id,
      targetUrl,
      credentialReference: options.credentialReference || DEFAULT_A2Z_CREDENTIAL_REFERENCE,
    });
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const credentials = await getA2ZCredentials(this.id);
    const products = await this.connectorService.fetchCatalog(this.targetUrl, credentials, this.outboundPolicy);
    return {
      products,
      targetUrl: this.targetUrl,
    };
  }

  public async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    const credentials = await getA2ZCredentials(this.id);
    return this.connectorService.fetchCatalogPage(this.targetUrl, credentials, this.outboundPolicy, request);
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
