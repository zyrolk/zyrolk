import { Product, SupplierReviewQueueItem } from '../../types';

export interface InboundProduct {
  supplierItemCode: string;
  name: string;
  description: string;
  costPrice: number; // Raw cost from the supplier
  stock: number;
  category: string;
  imageUrls: string[];
  specs: Record<string, string>;
}

export interface SupplierSource {
  id: string;
  name: string;
  connectionStatus: 'connected' | 'disconnected' | 'pending';
  lastSync: string;
  lastError: string;
  sourceStatus: 'active' | 'inactive';
  newProducts: number;
  priceChanges: number;
  stockChanges: number;
  imageChanges: number;
  pendingReviews: number;
  type: 'Website' | 'WhatsApp';
  connectorUrl?: string;
}

export interface SyncConfig {
  websiteSyncEnabled: boolean;
  whatsappSyncEnabled: boolean;
  autoSyncEnabled: boolean;
  autoImageDownload: boolean;
  notificationEnabled: boolean;
  syncInterval: string;
  defaultProfitMargin: number; // e.g. 15%
  defaultMarkup: number;       // e.g. 10%
  defaultImageLimit: number;   // e.g. 5 images
  lastUpdated: string;
  updatedBy: string;
}

export interface PriceComparisonResult {
  hasChanged: boolean;
  oldCostPrice: number;
  newCostPrice: number;
  oldPrice: number; // Selling price
  newPrice: number; // Calculated Selling price
  oldOriginalPrice?: number;
  newOriginalPrice?: number;
  markupPercent: number;
  marginPercent: number;
}

export interface ImageComparisonResult {
  hasChanged: boolean;
  addedUrls: string[];
  removedUrls: string[];
  finalUrls: string[];
}

export interface StockComparisonResult {
  hasChanged: boolean;
  oldStock: number;
  newStock: number;
}

export interface ProductComparisonResult {
  productId?: string; // If exists in local database
  supplierItemCode: string;
  changeType: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'IMAGE_CHANGED' | 'DESCRIPTION_CHANGED' | 'NONE';
  hasChanges: boolean;
  priceDetails?: PriceComparisonResult;
  imageDetails?: ImageComparisonResult;
  stockDetails?: StockComparisonResult;
  descriptionChanged: boolean;
  oldDescription?: string;
  newDescription?: string;
  nameChanged: boolean;
  oldName?: string;
  newName?: string;
}

export interface SyncHistoryEntry {
  id: string;
  supplierId: string;
  supplierName: string;
  timestamp: string;
  status: 'success' | 'failed';
  error: string;
  newProducts: number;
  priceChanges: number;
  stockChanges: number;
  imageChanges: number;
  pendingReviews: number;
  triggeredBy: string;
  durationMs: number;
  processedCount: number;
}

export interface ImportQueueEntry {
  id: string;
  supplierCode: string;
  supplierName: string;
  productName: string;
  source: 'Website' | 'WhatsApp';
  importStatus: 'Pending' | 'Downloading' | 'Completed' | 'Failed';
  progress: number;
  totalImages: number;
  downloadedImages: number;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}
