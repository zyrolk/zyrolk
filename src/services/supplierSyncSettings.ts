import { normalizeSupplierCategory } from './supplierCategoryMapping';

export type SupplierComparisonStatus =
  | 'NEW_PRODUCT'
  | 'PRICE_CHANGED'
  | 'STOCK_CHANGED'
  | 'DESCRIPTION_CHANGED'
  | 'IMAGE_CHANGED'
  | 'UNCHANGED';

export interface SupplierSourceSyncSettings {
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
}

const PRICE_FIELDS = new Set(['Cost Price', 'Market Price']);
const DESCRIPTION_FIELDS = new Set(['Product Name', 'Description']);

export function getSupplierProductLimit(productLimit: string | undefined, maximum = 250): number {
  const safeMaximum = Math.max(1, Math.floor(maximum));
  if (!productLimit || productLimit === 'All') return safeMaximum;

  const parsed = Number(productLimit);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), safeMaximum)
    : safeMaximum;
}

export function filterSupplierComparison(
  comparison: SupplierComparison,
  settings: SupplierSourceSyncSettings | undefined,
): SupplierComparison | null {
  if (comparison.status === 'UNCHANGED') return null;
  if (comparison.status === 'NEW_PRODUCT') {
    return settings?.syncNewProducts === false ? null : comparison;
  }

  const allowedFields = comparison.changedFields.filter((field) => {
    if (PRICE_FIELDS.has(field)) return settings?.syncPriceUpdates !== false;
    if (field === 'Stock') return settings?.syncStockUpdates !== false;
    if (DESCRIPTION_FIELDS.has(field)) return settings?.syncDescriptionUpdates !== false;
    if (field === 'Primary Image') return settings?.syncImageUpdates !== false;
    return false;
  });

  if (allowedFields.length === 0) return null;
  if (allowedFields.some((field) => PRICE_FIELDS.has(field))) {
    return { status: 'PRICE_CHANGED', changedFields: allowedFields };
  }
  if (allowedFields.includes('Stock')) return { status: 'STOCK_CHANGED', changedFields: allowedFields };
  if (allowedFields.includes('Primary Image')) return { status: 'IMAGE_CHANGED', changedFields: allowedFields };
  return { status: 'DESCRIPTION_CHANGED', changedFields: allowedFields };
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

export function isSupplierSourceAutoSyncDue(
  autoSync: string | undefined,
  lastSync: unknown,
  nowMs: number,
): boolean {
  const normalized = String(autoSync || 'Off').trim().toLowerCase();
  const intervals: Record<string, number> = {
    '15 minutes': 15 * 60 * 1000,
    '30 minutes': 30 * 60 * 1000,
    '1 hour': 60 * 60 * 1000,
    '6 hours': 6 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
  };
  const intervalMs = intervals[normalized];
  if (!intervalMs) return false;

  const lastSyncMs = typeof lastSync === 'number'
    ? lastSync
    : typeof lastSync === 'object' && lastSync !== null && 'toMillis' in lastSync && typeof lastSync.toMillis === 'function'
      ? lastSync.toMillis()
      : new Date(String(lastSync || '')).getTime();
  return !Number.isFinite(lastSyncMs) || lastSyncMs > nowMs || lastSyncMs + intervalMs <= nowMs;
}
