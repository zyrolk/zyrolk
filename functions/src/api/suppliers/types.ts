import { RawA2ZProduct } from "./a2z/types";

export interface SupplierSourceConfig {
  id: string;
  supplierId: string;
  /** Firebase Auth UID for the active Supplier Portal account that owns routing for this source. */
  supplierAccountId?: string;
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
  mode?: SupplierCatalogSyncMode;
  filters?: SupplierCatalogFilterRequest;
  incremental?: SupplierIncrementalCatalogRequest;
}

export interface SupplierCatalogPageResult extends SupplierFetchResult {
  nextCursor: string | null;
  complete: boolean;
  invalidProducts?: number;
  deltaToken?: string | null;
  /**
   * Optional total for the exact request scope represented by this traversal.
   * Supplier-reported totals remain useful operational context, but only an
   * explicitly exact total may drive determinate progress or an ETA.
   */
  catalogTotal?: SupplierCatalogTotal;
}

export interface SupplierCatalogTotal {
  count: number;
  reliability: "exact" | "reported";
}

export type SupplierCatalogSyncMode = "full" | "incremental";
export type SupplierCatalogFilterExecution = "supplier_native" | "server_side" | "unsupported";

export interface SupplierCatalogFilterRequest {
  category?: string;
  subcategory?: string;
  search?: string;
}

export type SupplierCatalogSyncContinuation = "continue" | "restart";

export interface SupplierSyncRequestControls {
  mode: SupplierCatalogSyncMode;
  filters?: SupplierCatalogFilterRequest;
  /** Optional connector page size. Persisted source settings remain the compatibility fallback. */
  pageSize?: number;
  /** Maximum supplier observations processed across the complete requested run. */
  totalProductLimit?: number;
  /**
   * Limited full-sync traversal control. Continue resumes the persisted supplier
   * cursor after a limit-terminated run; restart intentionally begins again.
   */
  catalogContinuation?: SupplierCatalogSyncContinuation;
}

export interface SupplierIncrementalCatalogRequest {
  updatedSince?: string;
  deltaToken?: string | null;
}

export interface SupplierIncrementalCapability {
  supported: boolean;
  mechanism: "updated_since" | "delta_token" | "change_cursor" | "unsupported";
  deletionSemantics: "tombstones" | "none";
}

export interface SupplierConnectorSyncCapabilities {
  incremental: SupplierIncrementalCapability;
  categoryFilter: SupplierCatalogFilterExecution;
  subcategoryFilter: SupplierCatalogFilterExecution;
  searchFilter: SupplierCatalogFilterExecution;
}

export interface SupplierConnector {
  id: string;
  name: string;
  connectorType: SupplierConnectorType;
  enabled: boolean;
  priority: number;
  capabilities: readonly string[];
  /** Code-owned capability contract; source-document strings never grant native behavior. */
  syncCapabilities?: Readonly<SupplierConnectorSyncCapabilities>;
  fetchProducts(): Promise<SupplierFetchResult>;
  fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult>;
  testConnection(): Promise<SupplierConnectionTestResult>;
}
