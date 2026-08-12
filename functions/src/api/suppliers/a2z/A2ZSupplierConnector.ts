import { A2ZConnectorService } from "./A2ZConnectorService";
import { getA2ZCredentials } from "../credentials";
import { SupplierCatalogPageRequest, SupplierCatalogPageResult, SupplierConnectionTestResult, SupplierConnector, SupplierConnectorSyncCapabilities, SupplierConnectorType, SupplierFetchResult } from "../types";
import { SupplierOutboundPolicy } from "../../security/supplierOutboundRequest";
import { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } from "../supplierSyncCapabilities";
import { normalizeA2ZCredentialReference } from "../a2zCredentialProfiles";

export const DEFAULT_A2Z_CREDENTIAL_REFERENCE = "firebase-secret-manager:A2Z_USERNAME+A2Z_PASSWORD";

export class A2ZSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly connectorType: SupplierConnectorType;
  public readonly enabled: boolean;
  public readonly priority: number;
  public readonly capabilities: readonly string[];
  public readonly syncCapabilities: Readonly<SupplierConnectorSyncCapabilities> = SERVER_FILTERED_FULL_CATALOG_CAPABILITIES;
  private readonly outboundPolicy: SupplierOutboundPolicy;
  private readonly connectorService: A2ZConnectorService;
  private readonly supplierId: string;
  private readonly credentialReference: string;

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
    this.supplierId = options.supplierId || this.id;
    this.credentialReference = normalizeA2ZCredentialReference(options.credentialReference || DEFAULT_A2Z_CREDENTIAL_REFERENCE);
    this.connectorService = new A2ZConnectorService({
      supplierId: this.supplierId,
      sourceId: this.id,
      targetUrl,
      credentialReference: this.credentialReference,
    });
  }

  private resolveCredentials(): Promise<{ username: string; password: string }> {
    return getA2ZCredentials({
      credentialReference: this.credentialReference,
      targetUrl: this.targetUrl,
      supplierId: this.supplierId,
      sourceId: this.id,
    });
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const credentials = await this.resolveCredentials();
    const products = await this.connectorService.fetchCatalog(this.targetUrl, credentials, this.outboundPolicy);
    return {
      products,
      targetUrl: this.targetUrl,
    };
  }

  public async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    if (request.mode === "incremental") throw new Error("A2Z does not support native incremental synchronization.");
    const credentials = await this.resolveCredentials();
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
