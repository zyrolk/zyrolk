import { DropexConnectorService, DROPEX_CREDENTIAL_VALIDATION_TARGET } from "./DropexConnectorService";
import { getDropexCredentials } from "../credentials";
import {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectionTestResult,
  SupplierConnector,
  SupplierConnectorSyncCapabilities,
  SupplierConnectorType,
  SupplierFetchResult,
} from "../types";
import { SupplierOutboundPolicy } from "../../security/supplierOutboundRequest";
import { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } from "../supplierSyncCapabilities";
import { normalizeDropexCredentialReference } from "../dropexCredentialProfiles";
import { DROPEX_DEFAULT_PORTAL_URL } from "./constants";

export class DropexSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly connectorType: SupplierConnectorType;
  public readonly enabled: boolean;
  public readonly priority: number;
  public readonly capabilities: readonly string[];
  public readonly syncCapabilities: Readonly<SupplierConnectorSyncCapabilities> = SERVER_FILTERED_FULL_CATALOG_CAPABILITIES;
  private readonly outboundPolicy: SupplierOutboundPolicy;
  private readonly connectorService: DropexConnectorService;
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
    this.id = options.sourceId || options.id || "dropex";
    this.name = options.name || "Dropex Supplier";
    this.connectorType = options.connectorType || "dropex";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
    this.capabilities = options.capabilities || ["catalog.fetch", "connection.test", "inventory.read"];
    this.outboundPolicy = options.outboundPolicy;
    this.supplierId = options.supplierId || this.id;
    this.credentialReference = normalizeDropexCredentialReference(options.credentialReference);
    this.connectorService = new DropexConnectorService({
      supplierId: this.supplierId,
      sourceId: this.id,
      credentialReference: this.credentialReference,
    });
  }

  private resolveCredentials(): Promise<{ username: string; password: string }> {
    return getDropexCredentials({
      credentialReference: this.credentialReference,
      targetUrl: DROPEX_CREDENTIAL_VALIDATION_TARGET,
      supplierId: this.supplierId,
      sourceId: this.id,
    });
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const credentials = await this.resolveCredentials();
    const products = await this.connectorService.fetchCatalog(credentials, this.outboundPolicy);
    return {
      products,
      targetUrl: this.targetUrl || DROPEX_DEFAULT_PORTAL_URL,
    };
  }

  public async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    if (request.mode === "incremental") throw new Error("Dropex does not support native incremental synchronization.");
    const credentials = await this.resolveCredentials();
    return this.connectorService.fetchCatalogPage(credentials, this.outboundPolicy, request);
  }

  public async testConnection(): Promise<SupplierConnectionTestResult> {
    try {
      const credentials = await this.resolveCredentials();
      const result = await this.connectorService.testConnection(credentials, this.outboundPolicy);
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
        error: error.message || "Authentication or fetch failed with Dropex supplier.",
      };
    }
  }
}
