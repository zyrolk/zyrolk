import type { Category, Order, Product, SupplierReviewQueueItem, WebsiteSettings } from '../../../types';
import type { AIDataSetReadiness, AIIntelligenceReadiness } from './domain';
import type { SalesSnapshot } from './sales';
import type { InventorySnapshot } from './inventory';
import type { SupplierSnapshot } from './supplier';
import type { PricingSnapshot } from './pricing';

export interface AIManagerSupplierSourceInput {
  readonly id?: string;
  readonly name?: string;
  readonly supplierName?: string;
  readonly sourceStatus?: string;
  readonly enabled?: boolean;
  readonly lastSync?: string | null;
}

export interface AIManagerSupplierSyncInput {
  readonly supplierId?: string;
  readonly sourceId?: string;
  readonly supplierCode?: string;
  readonly supplierName?: string;
  readonly source?: string;
  readonly timestamp?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly status?: string;
  readonly pendingReviews?: number;
}

export interface AIManagerSupplierPendingChangeInput {
  readonly id?: string;
  readonly reviewQueueItemId?: string;
  readonly sourceId?: string;
  readonly supplierCode?: string;
  readonly status?: string;
}

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
  readonly supplierSources: readonly AIManagerSupplierSourceInput[];
  readonly supplierReviewQueue: readonly SupplierReviewQueueItem[];
  readonly supplierPendingChanges: readonly AIManagerSupplierPendingChangeInput[];
  readonly supplierSyncHistory: readonly AIManagerSupplierSyncInput[];
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
  readonly inventory: InventorySnapshot;
  readonly suppliers: SupplierSnapshot;
  readonly pricing: PricingSnapshot;
  readonly dataSets: readonly AIDataSetReadiness[];
  readonly intelligence: readonly AIIntelligenceReadiness[];
  readonly privacy: {
    readonly containsCustomerRecords: false;
    readonly containsDirectIdentifiers: false;
    readonly mode: 'aggregate-only';
  };
}
