export interface InventorySnapshotProduct {
  readonly id: string;
  readonly name: string;
  readonly stock: number | null;
  readonly isActive: boolean;
}

export interface InventorySnapshot {
  readonly products: readonly InventorySnapshotProduct[];
}

export type InventoryHealthStatus = 'unavailable' | 'good' | 'attention' | 'critical';

export interface InventoryHealth {
  readonly status: InventoryHealthStatus;
  readonly label: string;
  readonly reasoning: string;
  readonly affectedCount: number;
  readonly affectedPercentage: number;
}

export interface StockDistributionItem {
  readonly key: 'healthy' | 'low' | 'out' | 'invalid';
  readonly label: string;
  readonly count: number;
  readonly percentage: number;
}

export interface StockDistribution {
  readonly activeProductCount: number;
  readonly items: readonly StockDistributionItem[];
}

export interface InventoryProductStatus {
  readonly id: string;
  readonly name: string;
  readonly stock: number;
}

export interface InventorySummary {
  readonly totalProducts: number;
  readonly activeProducts: number;
  readonly inactiveProducts: number;
  readonly inStockProducts: number;
  readonly outOfStockProducts: number;
  readonly lowStockProducts: number;
  readonly invalidStockProducts: number;
}

export interface InventoryMetrics {
  readonly hasProducts: boolean;
  readonly summary: InventorySummary;
  readonly health: InventoryHealth;
  readonly stockDistribution: StockDistribution;
  readonly lowStockProducts: readonly InventoryProductStatus[];
}

export type InventoryInsightSeverity = 'positive' | 'attention' | 'neutral';

export interface InventoryInsight {
  readonly code: string;
  readonly severity: InventoryInsightSeverity;
  readonly message: string;
}

export interface InventoryAnalysis {
  readonly metrics: InventoryMetrics;
  readonly insights: readonly InventoryInsight[];
}
