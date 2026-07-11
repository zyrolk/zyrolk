export type AIIntelligenceDomain =
  | 'sales'
  | 'inventory'
  | 'supplier'
  | 'pricing'
  | 'customer'
  | 'marketing';

export type AIDataSetId =
  | 'products'
  | 'pricing-products'
  | 'categories'
  | 'orders'
  | 'customers'
  | 'reviews'
  | 'supplier-sources'
  | 'supplier-review-queue'
  | 'supplier-sync-history'
  | 'settings';

export type AIReadinessStatus = 'ready' | 'limited' | 'unavailable';

export interface AIDataSetReadiness {
  readonly id: AIDataSetId;
  readonly label: string;
  readonly recordCount: number;
  readonly available: boolean;
}

export interface AIIntelligenceReadiness {
  readonly domain: AIIntelligenceDomain;
  readonly label: string;
  readonly description: string;
  readonly status: AIReadinessStatus;
  readonly requiredDataSets: readonly AIDataSetId[];
  readonly optionalDataSets: readonly AIDataSetId[];
  readonly availableDataSets: readonly AIDataSetReadiness[];
  readonly missingRequiredDataSets: readonly AIDataSetId[];
}
