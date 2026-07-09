import { SupplierConnectionTestResult, SupplierConnector, SupplierFetchResult } from "./types";

export class HttpSupplierConnector implements SupplierConnector {
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
    this.id = options.id || "http";
    this.name = options.name || "HTTP Supplier";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const resObj = await fetch(this.targetUrl, {
        signal: controller.signal,
        redirect: "error",
      });

      if (!resObj.ok) {
        throw new Error(`Supplier API returned HTTP ${resObj.status}`);
      }

      const data = await resObj.json();

      if (!Array.isArray(data)) {
        throw new Error("Invalid response format. Expected a JSON array of product objects.");
      }

      return {
        products: data,
        targetUrl: this.targetUrl,
      };
    } finally {
      clearTimeout(timeoutId);
    }
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
        error: error.message || "Failed to connect to the supplier endpoint.",
      };
    }
  }
}
