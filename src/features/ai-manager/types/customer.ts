export interface AnonymousCustomerPurchaseProfile {
  readonly orderCount: number;
  readonly lifetimeValue: number;
  readonly orderDates: readonly string[];
}

export interface CustomerSnapshot {
  readonly customerRecordCount: number;
  readonly purchaseProfiles: readonly AnonymousCustomerPurchaseProfile[];
  readonly excludedOrderCount: number;
}

export type CustomerHealthStatus = 'healthy' | 'attention' | 'critical';
export interface CustomerHealth {
  readonly status: CustomerHealthStatus;
  readonly label: string;
  readonly reasons: readonly string[];
  readonly repeatRateThreshold: 30;
  readonly orderFrequencyThreshold: 1.5;
}

export interface CustomerRetentionPeriod {
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly activeCustomers: number;
  readonly retainedCustomers: number;
  readonly retentionRate: number | null;
}

export interface CustomerRetentionSummary {
  readonly current: CustomerRetentionPeriod;
  readonly previous: CustomerRetentionPeriod;
  readonly trend: 'improving' | 'declining' | 'unchanged' | 'unavailable';
  readonly percentagePointChange: number | null;
}

export interface CustomerMetrics {
  readonly asOfDate: string;
  readonly hasUsableHistory: boolean;
  readonly totalCustomers: number;
  readonly activePurchasingCustomers: number;
  readonly newCustomers: number;
  readonly returningCustomers: number;
  readonly repeatPurchaseRate: number;
  readonly averageOrdersPerCustomer: number | null;
  readonly averageCustomerLifetimeValue: number | null;
  readonly customersWithMultiplePurchases: number;
  readonly customersWithSinglePurchase: number;
  readonly excludedOrderCount: number;
  readonly retention: CustomerRetentionSummary;
  readonly health: CustomerHealth;
}

export type CustomerInsightSeverity = 'positive' | 'attention' | 'neutral';
export interface CustomerInsight { readonly code: string; readonly severity: CustomerInsightSeverity; readonly message: string }
export interface CustomerAnalysis { readonly metrics: CustomerMetrics; readonly insights: readonly CustomerInsight[] }
