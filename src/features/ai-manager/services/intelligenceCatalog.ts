import type { AIDataSetId, AIIntelligenceDomain } from '../types/domain';

export interface IntelligenceCatalogEntry {
  readonly domain: AIIntelligenceDomain;
  readonly label: string;
  readonly description: string;
  readonly requiredDataSets: readonly AIDataSetId[];
  readonly optionalDataSets: readonly AIDataSetId[];
}

export const INTELLIGENCE_CATALOG: readonly IntelligenceCatalogEntry[] = Object.freeze([
  {
    domain: 'sales',
    label: 'Sales Intelligence',
    description: 'Order volume, revenue coverage, sales trends, and product performance readiness.',
    requiredDataSets: ['orders'],
    optionalDataSets: ['products', 'categories'],
  },
  {
    domain: 'inventory',
    label: 'Inventory Intelligence',
    description: 'Stock availability, low-stock exposure, and future replenishment readiness.',
    requiredDataSets: ['products'],
    optionalDataSets: ['orders', 'categories'],
  },
  {
    domain: 'supplier',
    label: 'Supplier Intelligence',
    description: 'Source coverage, review backlog, sync history, and supplier reliability readiness.',
    requiredDataSets: ['supplier-sources'],
    optionalDataSets: ['supplier-review-queue', 'supplier-sync-history'],
  },
  {
    domain: 'pricing',
    label: 'Pricing Intelligence',
    description: 'Cost, market, selling-price, and margin analysis readiness.',
    requiredDataSets: ['pricing-products'],
    optionalDataSets: ['orders', 'supplier-review-queue'],
  },
  {
    domain: 'customer',
    label: 'Customer Intelligence',
    description: 'Aggregate customer coverage, purchase activity, and review-sentiment readiness.',
    requiredDataSets: ['customers'],
    optionalDataSets: ['orders', 'reviews'],
  },
  {
    domain: 'marketing',
    label: 'Marketing Intelligence',
    description: 'Catalog, category, review, and sales signals available for future campaign planning.',
    requiredDataSets: ['products'],
    optionalDataSets: ['categories', 'orders', 'reviews', 'settings'],
  },
]);
