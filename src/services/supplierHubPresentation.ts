export type SupplierHubSection = 'suppliers' | 'review' | 'activity' | 'settings';

export type ProductReviewFilter =
  | 'new_products'
  | 'product_updates'
  | 'removed_products'
  | 'conflicts'
  | 'needs_attention'
  | 'approved_history';

export const PRODUCT_REVIEW_FILTERS: ReadonlyArray<{ id: ProductReviewFilter; label: string }> = [
  { id: 'new_products', label: 'New Products' },
  { id: 'product_updates', label: 'Product Updates' },
  { id: 'removed_products', label: 'Removed Products' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'needs_attention', label: 'Needs Attention' },
  { id: 'approved_history', label: 'Approved History' },
];

interface ReviewPresentationItem {
  status?: unknown;
  queueState?: unknown;
  comparison?: { comparisonStatus?: unknown } | null;
  productValidation?: { readyToPublish?: unknown; missingFields?: unknown[]; errors?: unknown[] } | null;
}

interface ChangePresentationItem {
  status?: unknown;
  queueState?: unknown;
  changeType?: unknown;
}

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();

const isRemovedChange = (value: unknown): boolean => {
  const state = normalized(value);
  return state.includes('removed') || state.includes('deleted') || state.includes('deactivat');
};

const isConflict = (item: ReviewPresentationItem | ChangePresentationItem): boolean => (
  normalized(item.status) === 'conflict' || normalized(item.queueState) === 'conflict'
);

const isApproved = (item: ReviewPresentationItem | ChangePresentationItem): boolean => (
  normalized(item.status) === 'approved' || normalized(item.queueState) === 'approved'
);

export function matchesProductReviewFilter(item: ReviewPresentationItem, filter: ProductReviewFilter): boolean {
  const comparisonStatus = normalized(item.comparison?.comparisonStatus);
  if (filter === 'approved_history') return isApproved(item);
  if (filter === 'conflicts') return isConflict(item);
  if (filter === 'removed_products') return isRemovedChange(comparisonStatus);
  if (filter === 'new_products') return comparisonStatus === 'new_product';
  if (filter === 'needs_attention') {
    return item.productValidation?.readyToPublish === false
      || (item.productValidation?.missingFields?.length || 0) > 0
      || (item.productValidation?.errors?.length || 0) > 0
      || ['retryable_failure', 'dead_letter'].includes(normalized(item.queueState));
  }
  return !isApproved(item)
    && !isConflict(item)
    && comparisonStatus !== 'new_product'
    && !isRemovedChange(comparisonStatus);
}

export function matchesProductChangeFilter(item: ChangePresentationItem, filter: ProductReviewFilter): boolean {
  if (filter === 'approved_history') return isApproved(item);
  if (filter === 'conflicts') return isConflict(item);
  if (filter === 'removed_products') return isRemovedChange(item.changeType);
  if (filter === 'product_updates') return !isApproved(item) && !isConflict(item) && !isRemovedChange(item.changeType);
  if (filter === 'needs_attention') return ['retryable_failure', 'dead_letter'].includes(normalized(item.queueState));
  return false;
}

export function supplierHealthLabel(source: Record<string, unknown>): string {
  const enabled = source.enabled !== false && source.isEnabled !== false;
  const status = normalized(source.sourceStatus || source.status);
  if (!enabled || status === 'disabled' || status === 'inactive') return 'Disabled';
  if (status === 'paused') return 'Paused';
  if (source.lastError) return 'Needs attention';
  if (normalized(source.connectionStatus) === 'connected') return 'Healthy';
  return 'Not checked';
}

export function supplierReviewApiState(filter: ProductReviewFilter): 'active' | 'conflict' | 'approved' {
  if (filter === 'approved_history') return 'approved';
  if (filter === 'conflicts') return 'conflict';
  return 'active';
}
