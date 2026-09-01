import { normalizeSupplierCategory } from './supplierCategoryMapping';
import { SupplierFieldChange } from '../api/suppliers/supplierProductImport';

export type SupplierComparisonStatus =
  | 'NEW_PRODUCT'
  | 'PRICE_CHANGED'
  | 'STOCK_CHANGED'
  | 'DESCRIPTION_CHANGED'
  | 'IMAGE_CHANGED'
  | 'UNCHANGED';

export interface SupplierSourceSyncSettings {
  priority?: number;
  productLimit?: string;
  syncNewProducts?: boolean;
  syncPriceUpdates?: boolean;
  syncStockUpdates?: boolean;
  syncDescriptionUpdates?: boolean;
  syncImageUpdates?: boolean;
  autoSync?: string;
  dryRunMode?: boolean;
  discoveredCategories?: string[];
}

export interface SupplierComparison {
  status: SupplierComparisonStatus;
  changedFields: string[];
  fieldChanges?: SupplierFieldChange[];
}

export function getSupplierProductLimit(productLimit: string | undefined, maximum = 250): number {
  const safeMaximum = Math.max(1, Math.floor(maximum));
  if (!productLimit || productLimit === 'All') return safeMaximum;
  const parsed = Number(productLimit);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), safeMaximum) : safeMaximum;
}

export function resolveSupplierProductLimit(
  sourceProductLimit: unknown,
  hubProductLimit: unknown,
  maximum = 250,
): number {
  const configuredValue = sourceProductLimit !== undefined && sourceProductLimit !== null && sourceProductLimit !== ''
    ? sourceProductLimit
    : hubProductLimit;
  return getSupplierProductLimit(
    configuredValue === undefined || configuredValue === null || configuredValue === ''
      ? 'All'
      : String(configuredValue),
    maximum,
  );
}

export function limitSupplierProducts<T>(products: readonly T[], productLimit: number): T[] {
  const safeLimit = Number.isFinite(productLimit) && productLimit > 0
    ? Math.floor(productLimit)
    : products.length;
  return products.slice(0, safeLimit);
}

export function filterSupplierComparison(
  comparison: SupplierComparison,
  _settings: SupplierSourceSyncSettings | undefined,
): SupplierComparison | null {
  // The legacy sync-mode fields remain readable/writable for document and UI
  // compatibility, but they are no longer discard controls. Once the canonical
  // manifest detects a meaningful supplier change, Product Review is the only
  // safe place to decide whether that observation reaches the live catalogue.
  if (comparison.status === 'UNCHANGED') return null;
  return comparison;
}

/**
 * Queue policy for an existing supplier offer. Rejected and suppressed offers
 * may be reviewed again even when the supplier payload is unchanged, but an
 * already-active deterministic queue item always wins to prevent duplicates.
 */
export function selectSupplierComparisonForReview(
  comparison: SupplierComparison,
  settings: SupplierSourceSyncSettings | undefined,
  offerReviewStatus: unknown,
  hasActiveQueueItem: boolean,
): SupplierComparison | null {
  const filtered = filterSupplierComparison(comparison, settings);
  if (filtered || comparison.status !== 'UNCHANGED' || hasActiveQueueItem) return filtered;
  const reviewStatus = String(offerReviewStatus || '').trim().toLowerCase();
  return reviewStatus === 'suppressed' || reviewStatus === 'rejected' ? comparison : null;
}

export function getSupplierImageLimit(value: unknown, maximum = 20): number {
  const safeMaximum = Math.max(1, Math.floor(maximum));
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), safeMaximum)
    : Math.min(5, safeMaximum);
}

export interface SupplierInitialPricing {
  sellingPrice: number;
  comparePrice: number;
  discountPercent: number;
}

export function calculateSupplierInitialPricing(
  costPrice: unknown,
  recommendedRetailPrice: unknown,
  markupPercent: unknown,
  profitMarginPercent: unknown,
): SupplierInitialPricing {
  const costProvided = costPrice !== undefined
    && costPrice !== null
    && !(typeof costPrice === "string" && !String(costPrice).trim());
  const cost = costProvided ? Math.max(0, Number(costPrice) || 0) : Number.NaN;
  const recommended = Math.max(0, Number(recommendedRetailPrice) || 0);
  const markup = markupPercent === undefined || markupPercent === null || markupPercent === ''
    ? 10
    : Math.max(0, Number(markupPercent) || 0);
  const margin = profitMarginPercent === undefined || profitMarginPercent === null || profitMarginPercent === ''
    ? 15
    : Math.max(0, Number(profitMarginPercent) || 0);
  const calculated = Number.isFinite(cost) ? Math.round(cost * (1 + (markup + margin) / 100)) : 0;
  const sellingPrice = calculated > 0 ? calculated : Math.round(recommended);
  const comparePrice = Math.max(sellingPrice, Math.round(recommended));
  const discountPercent = comparePrice > sellingPrice
    ? Math.round(((comparePrice - sellingPrice) / comparePrice) * 100)
    : 0;

  return { sellingPrice, comparePrice, discountPercent };
}

export function collectDiscoveredSupplierCategories(
  products: readonly { categoryHierarchy?: readonly string[] }[],
): string[] {
  const discovered = new Map<string, string>();
  products.forEach((product) => {
    (product.categoryHierarchy || []).forEach((value) => {
      const label = String(value || '').trim();
      const normalized = normalizeSupplierCategory(label);
      if (normalized && !discovered.has(normalized)) discovered.set(normalized, label);
    });
  });
  return Array.from(discovered.values()).sort((left, right) => left.localeCompare(right));
}

export function isSupplierSourceAutoSyncDue(autoSync: string | undefined, lastSync: unknown, nowMs: number): boolean {
  const intervals: Record<string, number> = {
    '15 minutes': 15 * 60 * 1000,
    '30 minutes': 30 * 60 * 1000,
    '1 hour': 60 * 60 * 1000,
    '3 hours': 3 * 60 * 60 * 1000,
    '6 hours': 6 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
  };
  const intervalMs = intervals[String(autoSync || 'Off').trim().toLowerCase()];
  if (!intervalMs) return false;
  const lastSyncMs = typeof lastSync === 'number'
    ? lastSync
    : typeof lastSync === 'object' && lastSync !== null && 'toMillis' in lastSync && typeof lastSync.toMillis === 'function'
      ? lastSync.toMillis()
      : new Date(String(lastSync || '')).getTime();
  return !Number.isFinite(lastSyncMs) || lastSyncMs > nowMs || lastSyncMs + intervalMs <= nowMs;
}
