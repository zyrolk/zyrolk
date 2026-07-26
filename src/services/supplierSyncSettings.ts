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
  fieldChanges?: Array<{
    label: string;
    syncGroup: 'identity' | 'pricing' | 'inventory' | 'content' | 'media' | 'category' | 'status' | 'metadata';
  }>;
}

const PRICE_FIELDS = new Set(['Cost Price', 'Market Price']);
const IMAGE_FIELDS = new Set(['Primary Image', 'Images']);

const syncGroupForLabel = (field: string): NonNullable<SupplierComparison['fieldChanges']>[number]['syncGroup'] => {
  if (PRICE_FIELDS.has(field)) return 'pricing';
  if (field === 'Stock') return 'inventory';
  if (IMAGE_FIELDS.has(field)) return 'media';
  return 'content';
};

const groupIsEnabled = (
  group: NonNullable<SupplierComparison['fieldChanges']>[number]['syncGroup'],
  settings: SupplierSourceSyncSettings | undefined,
): boolean => {
  if (group === 'pricing') return settings?.syncPriceUpdates !== false;
  if (group === 'inventory') return settings?.syncStockUpdates !== false;
  if (group === 'media') return settings?.syncImageUpdates !== false;
  return settings?.syncDescriptionUpdates !== false;
};

export function getSupplierProductLimit(productLimit: string | undefined, maximum = 250): number {
  const safeMaximum = Math.max(1, Math.floor(maximum));
  if (!productLimit || productLimit === 'All') return safeMaximum;

  const parsed = Number(productLimit);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), safeMaximum)
    : safeMaximum;
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
  settings: SupplierSourceSyncSettings | undefined,
): SupplierComparison | null {
  if (comparison.status === 'UNCHANGED') return null;
  if (comparison.status === 'NEW_PRODUCT') {
    return settings?.syncNewProducts === false ? null : comparison;
  }

  const allowedFieldChanges = comparison.fieldChanges?.filter((change) => groupIsEnabled(change.syncGroup, settings));
  const allowedFields = comparison.fieldChanges
    ? [...new Set((allowedFieldChanges || []).map((change) => change.label))]
    : comparison.changedFields.filter((field) => groupIsEnabled(syncGroupForLabel(field), settings));

  if (allowedFields.length === 0) return null;
  const allowedGroups = new Set(allowedFieldChanges?.map((change) => change.syncGroup) || allowedFields.map(syncGroupForLabel));
  const filteredChanges = allowedFieldChanges && allowedFieldChanges.length > 0 ? { fieldChanges: allowedFieldChanges } : {};
  if (allowedGroups.has('pricing')) return { status: 'PRICE_CHANGED', changedFields: allowedFields, ...filteredChanges };
  if (allowedGroups.has('inventory')) return { status: 'STOCK_CHANGED', changedFields: allowedFields, ...filteredChanges };
  if (allowedGroups.has('media')) return { status: 'IMAGE_CHANGED', changedFields: allowedFields, ...filteredChanges };
  return { status: 'DESCRIPTION_CHANGED', changedFields: allowedFields, ...filteredChanges };
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
  const cost = Math.max(0, Number(costPrice) || 0);
  const recommended = Math.max(0, Number(recommendedRetailPrice) || 0);
  const markup = markupPercent === undefined || markupPercent === null || markupPercent === ''
    ? 10
    : Math.max(0, Number(markupPercent) || 0);
  const margin = profitMarginPercent === undefined || profitMarginPercent === null || profitMarginPercent === ''
    ? 15
    : Math.max(0, Number(profitMarginPercent) || 0);
  const calculated = Math.round(cost * (1 + (markup + margin) / 100));
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
