import { InboundProduct } from '../../sync-engine/types';

export interface RawA2ZProduct {
  sku: string;                    // Supplier code / unique identifier
  title: string;                  // Product name
  longDescription: string;        // Product description
  mediaGallery: string[];         // Image URLs
  wholesalePrice: number;         // Cost Price
  recommendedRetailPrice: number; // Market Price / Selling reference
  inventoryLevel: number;         // Stock count
  categoryHierarchy?: string[];   // Category crumbs
  specifications?: Record<string, string>;
}

export interface ConnectorLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  module: string;
  message: string;
  details?: Record<string, any>;
}

export interface FetchOptions {
  limit?: number;
  offset?: number;
  category?: string;
  includeOutOfStock?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}
