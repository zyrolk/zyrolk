import { SupplierCatalogPageRequest, SupplierCatalogPageResult, SupplierConnectionTestResult, SupplierConnector, SupplierConnectorType, SupplierFetchResult } from "./types";
import { fetchSupplierOutbound, SupplierOutboundPolicy } from "../security/supplierOutboundRequest";

export function resolveSupplierProductArray(data: unknown, dataPath = ""): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const path = dataPath.trim();
  if (!path) throw new Error("Invalid response format. Expected a JSON array of product objects.");
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => !/^[a-zA-Z0-9_-]+$/u.test(segment))) {
    throw new Error("Supplier API response data path is invalid.");
  }
  let current: unknown = data;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Supplier API response does not contain an array at "${path}".`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(current)) throw new Error(`Supplier API response does not contain an array at "${path}".`);
  return current as Record<string, unknown>[];
}

export class HttpSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly connectorType: SupplierConnectorType;
  public readonly enabled: boolean;
  public readonly priority: number;
  public readonly capabilities: readonly string[];
  private readonly outboundPolicy: SupplierOutboundPolicy;
  private readonly dataPath: string;

  constructor(
    private readonly targetUrl: string,
    options: {
      id?: string;
      name?: string;
      connectorType?: SupplierConnectorType;
      enabled?: boolean;
      priority?: number;
      capabilities?: readonly string[];
      dataPath?: string;
      outboundPolicy: SupplierOutboundPolicy;
    },
  ) {
    this.id = options.id || "http";
    this.name = options.name || "HTTP Supplier";
    this.connectorType = options.connectorType || "http";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
    this.capabilities = options.capabilities || ["catalog.fetch", "connection.test"];
    this.dataPath = options.dataPath || "";
    this.outboundPolicy = options.outboundPolicy;
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const { data, targetUrl } = await this.fetchJson();
    return {
      products: resolveSupplierProductArray(data, this.dataPath),
      targetUrl,
    };
  }

  private async fetchJson(targetUrl?: string): Promise<{ data: unknown; targetUrl: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const resObj = targetUrl
        ? await fetchSupplierOutbound(targetUrl, { signal: controller.signal }, this.outboundPolicy)
        : await fetchSupplierOutbound(this.targetUrl, { signal: controller.signal }, this.outboundPolicy);

      if (!resObj.ok) {
        throw new Error(`Supplier API returned HTTP ${resObj.status}`);
      }

      return { data: await resObj.json(), targetUrl: targetUrl || this.targetUrl };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    const pageSize = Math.max(1, Math.min(Number(request.pageSize) || 100, 200));
    const localOffset = request.cursor?.startsWith("http-local:")
      ? Math.max(0, Number(request.cursor.slice("http-local:".length)) || 0)
      : 0;
    const remoteOffset = request.cursor && /^\d+$/u.test(request.cursor)
      ? Math.max(0, Number(request.cursor))
      : 0;
    const requestUrl = new URL(this.targetUrl);
    if (!request.cursor?.startsWith("http-local:")) {
      requestUrl.searchParams.set("limit", String(pageSize));
      if (request.cursor) {
        requestUrl.searchParams.set("cursor", request.cursor);
        if (/^\d+$/u.test(request.cursor)) requestUrl.searchParams.set("offset", request.cursor);
      }
    }
    const { data, targetUrl } = await this.fetchJson(requestUrl.toString());
    const allProducts = resolveSupplierProductArray(data, this.dataPath);
    const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const pagination = root.pagination && typeof root.pagination === "object" && !Array.isArray(root.pagination)
      ? root.pagination as Record<string, unknown>
      : root.meta && typeof root.meta === "object" && !Array.isArray(root.meta)
        ? root.meta as Record<string, unknown>
        : {};
    const hasExplicitCursor = [root, pagination].some((record) => Object.hasOwn(record, "nextCursor") || Object.hasOwn(record, "next_cursor"));
    const explicitCursorValue = root.nextCursor ?? root.next_cursor ?? pagination.nextCursor ?? pagination.next_cursor;
    const explicitCursor = typeof explicitCursorValue === "string" && explicitCursorValue.trim() ? explicitCursorValue.trim() : null;
    const usesLocalPagination = allProducts.length > pageSize || request.cursor?.startsWith("http-local:") === true;
    const products = usesLocalPagination ? allProducts.slice(localOffset, localOffset + pageSize) : allProducts;
    const consumed = (usesLocalPagination ? localOffset : remoteOffset) + products.length;
    const reportedTotal = Number(root.total ?? root.count ?? pagination.total ?? pagination.count);
    const hasMoreValue = root.hasMore ?? root.has_more ?? pagination.hasMore ?? pagination.has_more;
    const complete = usesLocalPagination
      ? consumed >= allProducts.length
      : hasExplicitCursor
        ? !explicitCursor
        : typeof hasMoreValue === "boolean"
          ? !hasMoreValue
          : Number.isFinite(reportedTotal)
            ? consumed >= reportedTotal
            : products.length < pageSize;
    const nextCursor = complete
      ? null
      : usesLocalPagination
        ? `http-local:${consumed}`
        : explicitCursor || String(consumed);
    return { products, targetUrl, nextCursor, complete };
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
