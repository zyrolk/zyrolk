import type { Category, Order, Product, SupplierReviewQueueItem, WebsiteSettings } from '../../../types';
import type { SupplierSource, SyncHistoryEntry } from '../../../services/sync-engine/types';
import type { AIDataSetReadiness, AIIntelligenceReadiness } from './domain';
import type { SalesSnapshot } from './sales';

export interface AIManagerCustomerInput {
  readonly id?: string;
  readonly uid?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly displayName?: string;
}

export interface AIManagerReviewInput {
  readonly id?: string;
  readonly productId?: string;
  readonly rating?: number;
  readonly approved?: boolean;
  readonly comment?: string;
  readonly customerName?: string;
  readonly userName?: string;
}

export interface AIManagerSourceData {
  readonly products: readonly Product[];
  readonly categories: readonly Category[];
  readonly orders: readonly Order[];
  readonly customers: readonly AIManagerCustomerInput[];
  readonly reviews: readonly AIManagerReviewInput[];
  readonly supplierSources: readonly SupplierSource[];
  readonly supplierReviewQueue: readonly SupplierReviewQueueItem[];
  readonly supplierSyncHistory: readonly SyncHistoryEntry[];
  readonly settings: WebsiteSettings | null;
}

export interface AIManagerMetrics {
  readonly productCount: number;
  readonly activeProductCount: number;
  readonly outOfStockCount: number;
  readonly lowStockCount: number;
  readonly orderCount: number;
  readonly nonCancelledRevenue: number;
  readonly customerCount: number;
  readonly reviewCount: number;
  readonly pendingSupplierReviewCount: number;
}

export interface AIManagerSnapshot {
  readonly metrics: AIManagerMetrics;
  readonly sales: SalesSnapshot;
  readonly dataSets: readonly AIDataSetReadiness[];
  readonly intelligence: readonly AIIntelligenceReadiness[];
  readonly privacy: {
    readonly containsCustomerRecords: false;
    readonly containsDirectIdentifiers: false;
    readonly mode: 'aggregate-only';
  };
}
