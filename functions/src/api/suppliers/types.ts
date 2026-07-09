import { RawA2ZProduct } from "./a2z/types";

export interface SupplierSourceConfig {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  websiteUrl: string;
  endpoint: string;
  raw: FirebaseFirestore.DocumentData;
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

export interface SupplierConnector {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  fetchProducts(): Promise<SupplierFetchResult>;
  testConnection(): Promise<SupplierConnectionTestResult>;
}
