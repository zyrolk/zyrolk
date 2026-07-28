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

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();

interface FirestoreTimestampLike {
  toDate?: () => Date;
  seconds?: number;
  _seconds?: number;
}

/** Formats Firestore and API timestamps without ever leaking an invalid date label. */
export function formatSupplierTimestamp(value: unknown, missingLabel = 'Not updated yet'): string {
  if (value === null || value === undefined || value === '') return missingLabel;

  let parsed: Date | null = null;
  if (value instanceof Date) {
    parsed = value;
  } else if (typeof value === 'object') {
    const timestamp = value as FirestoreTimestampLike;
    if (typeof timestamp.toDate === 'function') {
      try {
        parsed = timestamp.toDate();
      } catch {
        parsed = null;
      }
    } else {
      const seconds = timestamp.seconds ?? timestamp._seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) parsed = new Date(seconds * 1_000);
    }
  } else if (typeof value === 'string' || typeof value === 'number') {
    parsed = new Date(value);
  }

  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : missingLabel;
}

interface SupplierAdminIdentity {
  uid?: unknown;
  displayName?: unknown;
  email?: unknown;
}

/** Presents a human administrator identity and never exposes a Firebase UID. */
export function supplierAdministratorLabel(
  actor: unknown,
  currentAdmin?: SupplierAdminIdentity | null,
): string {
  const displayName = String(currentAdmin?.displayName || '').trim();
  const email = String(currentAdmin?.email || '').trim();
  const currentUid = String(currentAdmin?.uid || '').trim();

  if (actor && typeof actor === 'object') {
    const record = actor as Record<string, unknown>;
    const actorName = String(record.displayName || record.name || '').trim();
    const actorEmail = String(record.email || '').trim();
    if (actorName) return actorName;
    if (actorEmail) return actorEmail;
  }

  const raw = String(actor || '').trim();
  if (raw.includes('@')) return raw;
  if (raw && currentUid && raw === currentUid) return displayName || email || 'Administrator';
  return 'Administrator';
}

export function supplierReviewDecisionReady(item: ReviewPresentationItem): boolean {
  const state = normalized(item.queueState);
  return state === 'review_pending' || state === 'conflict' || (!state && normalized(item.status) === 'pending');
}

export function supplierReviewStatusLabel(item: ReviewPresentationItem): string {
  const state = normalized(item.queueState);
  if (state === 'queued' || state === 'leased' || state === 'processing') return 'Preparing';
  if (state === 'review_pending') return 'Ready for Review';
  if (state === 'retryable_failure') return 'Needs Attention';
  if (state === 'dead_letter') return 'Needs Attention';
  if (state === 'conflict') return 'Needs Attention';
  if (state === 'approved') return 'Approved';
  if (state === 'rejected' || state === 'suppressed') return 'Rejected';
  if (!state && normalized(item.status) === 'pending') return 'Ready for Review';
  return String(item.status || 'Preparing');
}

export function hasSupplierHubAdvancedAccess(claims: Record<string, unknown>): boolean {
  const role = normalized(claims.role).replace('-', '_');
  return claims.superAdmin === true
    || claims.supplierHubSuperAdmin === true
    || role === 'super_admin'
    || role === 'owner';
}

export function supplierBusinessErrorMessage(value: unknown, fallback = 'Supplier Hub could not complete that action.'): string {
  const message = value instanceof Error ? value.message : String(value || '');
  const key = normalized(message);
  if (!key) return fallback;
  if (key.includes('appcheck') || key.includes('app check') || key.includes('app verification') || key.includes('throttled')) {
    return 'Your secure session could not be verified. Refresh the page and try again.';
  }
  if (key.includes('authentication required') || key.includes('id token') || key.includes('unauthorized')) {
    return 'Your admin session has expired. Sign in again and retry.';
  }
  if (key.includes('failed to fetch') || key.includes('network') || key.includes('connection closed')) {
    return 'Supplier Hub could not reach the service. Check your connection and retry.';
  }
  if (key.includes('permission') || key.includes('forbidden')) {
    return 'You do not have permission to complete this Supplier Hub action.';
  }
  return message || fallback;
}

interface ReviewChangeSummary {
  comparisonStatus?: unknown;
  changedFields?: unknown[];
  fieldChanges?: Array<{ label?: unknown }> | null;
}

interface ChangePresentationItem {
  status?: unknown;
  queueState?: unknown;
  changeType?: unknown;
}

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
  const operationalState = normalized(source.operationalState);
  const status = normalized(source.sourceStatus || source.status);
  if (operationalState === 'paused') return 'Paused';
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

/** Uses the canonical field changes when available instead of the legacy coarse status. */
export function supplierReviewChangeLabel(comparison: ReviewChangeSummary | null | undefined): string {
  const status = normalized(comparison?.comparisonStatus);
  if (status === 'new_product') return 'New product';
  if (isRemovedChange(status)) return 'Removed product';
  if (status === 'unchanged') return 'No supplier changes';

  const canonicalLabels = (comparison?.fieldChanges || [])
    .map((change) => String(change?.label || '').trim())
    .filter(Boolean);
  const fallbackLabels = (comparison?.changedFields || [])
    .map((label) => String(label || '').trim())
    .filter(Boolean);
  const labels = [...new Set(canonicalLabels.length > 0 ? canonicalLabels : fallbackLabels)];
  if (labels.length === 1) return `${labels[0]} changed`;
  if (labels.length > 1) return `${labels.length} supplier changes`;

  if (status === 'price_changed') return 'Price changed';
  if (status === 'stock_changed') return 'Stock changed';
  if (status === 'image_changed') return 'Images changed';
  if (status === 'description_changed') return 'Product details changed';
  return 'Supplier update';
}
