import { RawA2ZProduct } from "./a2z/types";

export interface SupplierSourceConfig {
  id: string;
  supplierId: string;
  name: string;
  connectorType: SupplierConnectorType;
  enabled: boolean;
  priority: number;
  currency: string;
  timezone: string;
  syncSchedule: string;
  authentication: SupplierAuthenticationConfiguration;
  capabilities: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
  websiteUrl: string;
  endpoint: string;
  raw: FirebaseFirestore.DocumentData;
}

export type SupplierConnectorType = "a2z" | "http" | "rest" | "xml" | "csv" | "shopify" | "woocommerce" | (string & {});

/** Metadata only. Secrets remain in Secret Manager or protected source config. */
export interface SupplierAuthenticationConfiguration {
  mode: "none" | "secret_manager" | "basic" | "api_key" | "oauth2";
  secretRef?: string;
  credentialProfile?: string;
}

export interface SupplierConnectionTestResult {
  success: boolean;
  status: "Connected" | "Failed";
  productsCount: number;
  sampleProduct: RawA2ZProduct | Record<string, unknown> | null;
  error?: string;
}

export interface SupplierFetchResult {
  products: RawA2ZProduct[] | Record<string, unknown>[];
  targetUrl: string;
}

export interface SupplierCatalogPageRequest {
  cursor: string | null;
  pageSize: number;
}

export interface SupplierCatalogPageResult extends SupplierFetchResult {
  nextCursor: string | null;
  complete: boolean;
  invalidProducts?: number;
}

export interface SupplierConnector {
  id: string;
  name: string;
  connectorType: SupplierConnectorType;
  enabled: boolean;
  priority: number;
  capabilities: readonly string[];
  fetchProducts(): Promise<SupplierFetchResult>;
  fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult>;
  testConnection(): Promise<SupplierConnectionTestResult>;
}
