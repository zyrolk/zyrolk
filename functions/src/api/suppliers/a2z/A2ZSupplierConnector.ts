import { A2ZConnectorService } from "./A2ZConnectorService";
import { getA2ZCredentials } from "../credentials";
import { SupplierConnectionTestResult, SupplierConnector, SupplierFetchResult } from "../types";

export class A2ZSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly enabled: boolean;
  public readonly priority: number;

  constructor(
    private readonly targetUrl: string,
    options: {
      id?: string;
      name?: string;
      enabled?: boolean;
      priority?: number;
    } = {},
  ) {
    this.id = options.id || "a2z";
    this.name = options.name || "A2Z Supplier";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const credentials = await getA2ZCredentials();
    const products = await A2ZConnectorService.fetchCatalog(this.targetUrl, credentials);
    return {
      products,
      targetUrl: this.targetUrl,
    };
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
