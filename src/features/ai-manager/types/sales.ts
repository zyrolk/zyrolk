export interface SalesSnapshotItem {
  readonly productId: string;
  readonly productName: string;
  readonly unitPrice: number;
  readonly quantity: number;
}

export interface SalesSnapshotOrder {
  readonly createdAt: string;
  readonly status: string;
  readonly totalPrice: number;
  readonly items: readonly SalesSnapshotItem[];
}

export interface SalesSnapshot {
  readonly orders: readonly SalesSnapshotOrder[];
}

export interface SalesPeriodMetrics {
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly revenue: number;
  readonly orderCount: number;
  readonly averageOrderValue: number | null;
  readonly hasSales: boolean;
}

export type SalesTrendDirection = 'up' | 'down' | 'flat' | 'no-baseline';

export interface SalesTrendComparison {
  readonly direction: SalesTrendDirection;
  readonly absoluteChange: number;
  readonly percentageChange: number | null;
  readonly currentValue: number;
  readonly previousValue: number;
}

export interface RevenueSummary {
  readonly totalRevenue: number;
  readonly totalOrderCount: number;
  readonly averageOrderValue: number | null;
  readonly currentSevenDays: SalesPeriodMetrics;
  readonly previousSevenDays: SalesPeriodMetrics;
  readonly revenueTrend: SalesTrendComparison;
  readonly orderTrend: SalesTrendComparison;
}

export interface ProductSalesPerformance {
  readonly productId: string;
  readonly productName: string;
  readonly revenue: number;
  readonly quantity: number;
  readonly orderCount: number;
}

export interface ProductRanking {
  readonly highest: readonly ProductSalesPerformance[];
  readonly lowest: readonly ProductSalesPerformance[];
}

export interface OrderStatusBreakdown {
  readonly status: string;
  readonly orderCount: number;
  readonly revenue: number;
  readonly percentageOfOrders: number;
}

export interface OrderBreakdown {
  readonly totalOrders: number;
  readonly statuses: readonly OrderStatusBreakdown[];
}

export interface RevenueTrendPoint {
  readonly date: string;
  readonly revenue: number;
  readonly orderCount: number;
}

export interface SalesMetrics {
  readonly asOfDate: string;
  readonly hasOrders: boolean;
  readonly hasNonCancelledSales: boolean;
  readonly today: SalesPeriodMetrics;
  readonly lastSevenDays: SalesPeriodMetrics;
  readonly lastThirtyDays: SalesPeriodMetrics;
  readonly revenueSummary: RevenueSummary;
  readonly revenueRanking: ProductRanking;
  readonly quantityRanking: ProductRanking;
  readonly orderBreakdown: OrderBreakdown;
  readonly revenueTrend: readonly RevenueTrendPoint[];
}

export type SalesInsightSeverity = 'positive' | 'attention' | 'neutral';

export interface SalesInsight {
  readonly code: string;
  readonly severity: SalesInsightSeverity;
  readonly message: string;
}

export interface SalesAnalysis {
  readonly metrics: SalesMetrics;
  readonly insights: readonly SalesInsight[];
}
