export interface PricingSnapshotProduct {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly sellingPrice: number | null;
  readonly originalPrice: number | null;
  readonly storedDiscount: number | null;
}

export interface PricingSnapshot { readonly products: readonly PricingSnapshotProduct[] }

export interface PricingCatalogueSummary {
  readonly totalProducts: number;
  readonly activeProducts: number;
  readonly inactiveProducts: number;
}

export type PricingHealthStatus = 'healthy' | 'attention' | 'critical' | 'unavailable';
export interface PricingHealth {
  readonly status: PricingHealthStatus;
  readonly label: string;
  readonly reasons: readonly string[];
  readonly healthyDiscountThreshold: 20;
}

export type PricingIssueCategory =
  | 'missing-selling-price'
  | 'non-finite-selling-price'
  | 'negative-selling-price'
  | 'non-finite-original-price'
  | 'non-positive-original-price'
  | 'selling-above-original'
  | 'invalid-stored-discount'
  | 'stored-discount-mismatch';

export interface PricingIssueSummary {
  readonly category: PricingIssueCategory;
  readonly label: string;
  readonly count: number;
}

export interface PricingProductIssue {
  readonly id: string;
  readonly name: string;
  readonly categories: readonly PricingIssueCategory[];
}

export interface DiscountDistributionItem {
  readonly key: 'none' | 'up-to-10' | 'up-to-20' | 'up-to-30' | 'above-30';
  readonly label: string;
  readonly count: number;
  readonly percentage: number;
}

export interface DiscountSummary {
  readonly discountedProducts: number;
  readonly nonDiscountedProducts: number;
  readonly coveragePercentage: number;
  readonly distribution: readonly DiscountDistributionItem[];
}

export interface PricedProduct {
  readonly id: string;
  readonly name: string;
  readonly sellingPrice: number;
}

export interface PriceDistribution {
  readonly averageSellingPrice: number | null;
  readonly medianSellingPrice: number | null;
  readonly highestPricedProducts: readonly PricedProduct[];
  readonly lowestPricedProducts: readonly PricedProduct[];
}

export interface PricingMetrics {
  readonly hasActiveProducts: boolean;
  readonly catalogue: PricingCatalogueSummary;
  readonly productsWithSalePrices: number;
  readonly productsWithoutSalePrices: number;
  readonly productsMissingOriginalPrice: number;
  readonly productsWithInvalidPricing: number;
  readonly invalidPricing: readonly PricingIssueSummary[];
  readonly consistencyIssues: readonly PricingIssueSummary[];
  readonly productIssues: readonly PricingProductIssue[];
  readonly health: PricingHealth;
  readonly discounts: DiscountSummary;
  readonly prices: PriceDistribution;
}

export type PricingInsightSeverity = 'positive' | 'attention' | 'neutral';
export interface PricingInsight { readonly code: string; readonly severity: PricingInsightSeverity; readonly message: string }
export interface PricingAnalysis { readonly metrics: PricingMetrics; readonly insights: readonly PricingInsight[] }
