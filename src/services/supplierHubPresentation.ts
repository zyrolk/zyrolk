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
  { id: 'approved_history', label: 'Approval History' },
];

export interface ReviewPresentationItem {
  status?: unknown;
  queueState?: unknown;
  decisionAction?: unknown;
  mediaStatus?: unknown;
  comparison?: { comparisonStatus?: unknown } | null;
  productValidation?: { readyToPublish?: unknown; missingFields?: unknown[]; errors?: unknown[] } | null;
}

export interface SupplierReviewQuickApprovalItem extends ReviewPresentationItem {
  comparisonStatus?: unknown;
  reconciliationAction?: unknown;
  approvalConflict?: unknown;
  supplierOfferPendingRevision?: unknown;
  managedMedia?: unknown;
  productPayload?: {
    specs?: unknown;
    media?: unknown;
    supplierMedia?: unknown;
  } | null;
}

export interface SupplierReviewDisplayOption {
  id?: unknown;
  name?: unknown;
}

export type SupplierReviewTerminalAction = 'approved' | 'rejected';

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

/** Formats persisted sync latency without inventing a duration when no run exists. */
export function formatSupplierDuration(value: unknown, missingLabel = 'Not available'): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return missingLabel;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} sec`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return seconds > 0 ? `${minutes} min ${seconds} sec` : `${minutes} min`;
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

export function supplierReviewIsConflict(item: SupplierReviewQuickApprovalItem): boolean {
  return normalized(item.status) === 'conflict'
    || normalized(item.queueState) === 'conflict'
    || Boolean(item.approvalConflict);
}

export function supplierReviewIsRemoval(item: SupplierReviewQuickApprovalItem): boolean {
  const comparisonStatus = normalized(item.comparison?.comparisonStatus || item.comparisonStatus);
  const reconciliationAction = normalized(item.reconciliationAction);
  return isRemovedChange(comparisonStatus)
    || reconciliationAction === 'supplier_offer_unavailable';
}

/**
 * Quick approval is deliberately limited to current, revision-bound queue
 * observations. Legacy or terminal records remain available through the
 * detailed review path, while the server still performs the authoritative
 * revision comparison inside the approval transaction.
 */
export function supplierReviewIsStale(item: SupplierReviewQuickApprovalItem): boolean {
  const revision = String(item.supplierOfferPendingRevision || '').trim();
  return normalized(item.status) !== 'pending'
    || normalized(item.queueState) !== 'review_pending'
    || !/^[a-f0-9]{64}$/u.test(revision);
}

const managedMediaRecords = (item: SupplierReviewQuickApprovalItem): Array<Record<string, unknown>> => {
  const payload = item.productPayload || {};
  const candidates = [item.managedMedia, payload.supplierMedia, payload.media];
  const selected = candidates.find((value) => Array.isArray(value) && value.length > 0);
  return Array.isArray(selected)
    ? selected.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : [];
};

/** Returns only a managed Firebase Storage URL that approval can publish. */
export function supplierReviewManagedImageUrl(item: SupplierReviewQuickApprovalItem): string {
  const ordered = managedMediaRecords(item).sort((left, right) => {
    const primaryDifference = Number(right.isPrimary === true) - Number(left.isPrimary === true);
    if (primaryDifference !== 0) return primaryDifference;
    return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
  });
  const url = String(ordered[0]?.firebaseStorageUrl || '').trim();
  return /^https:\/\/\S+$/iu.test(url) ? url : '';
}

/** Uses the canonical approval payload field instead of the legacy UI alias. */
export function supplierReviewSpecificationCount(item: SupplierReviewQuickApprovalItem): number {
  const specs = item.productPayload?.specs;
  return specs && typeof specs === 'object' && !Array.isArray(specs)
    ? Object.keys(specs).length
    : 0;
}

export function supplierReviewCanQuickApprove(item: SupplierReviewQuickApprovalItem): boolean {
  const validation = item.productValidation;
  return validation?.readyToPublish === true
    && (validation.missingFields?.length || 0) === 0
    && (validation.errors?.length || 0) === 0
    && !supplierReviewIsConflict(item)
    && !supplierReviewIsRemoval(item)
    && !supplierReviewIsStale(item)
    && Boolean(supplierReviewManagedImageUrl(item));
}

/**
 * Resolves only a verified catalogue display name. The underlying identifier is
 * deliberately never returned because Product Review quick cards are an
 * operator-facing summary rather than a document-inspection surface.
 */
export function supplierReviewDisplayLabel(
  identifier: unknown,
  options: readonly SupplierReviewDisplayOption[],
): string {
  const normalizedIdentifier = String(identifier || '').trim();
  if (!normalizedIdentifier) return 'Not available';
  const matched = options.find((option) => String(option.id || '').trim() === normalizedIdentifier);
  const label = String(matched?.name || '').trim();
  if (label) return label;
  return options.length === 0 ? 'Loading…' : 'Not available';
}

/**
 * Immediately removes decision controls after a successful server decision.
 * A subsequent queue refresh may remove the item from the active filter, but a
 * failed refresh must never make the already-decided item actionable again.
 */
export function supplierReviewTerminalItem<T extends ReviewPresentationItem>(
  item: T,
  action: SupplierReviewTerminalAction,
): T {
  const approved = action === 'approved';
  return {
    ...item,
    status: approved ? 'Approved' : 'Rejected',
    queueState: action,
    decisionAction: action,
  };
}

export function supplierReviewStatusLabel(item: ReviewPresentationItem): string {
  const state = normalized(item.queueState);
  if (state === 'queued' || state === 'leased' || state === 'processing') return 'Preparing';
  if (state === 'review_pending') return 'Ready for Review';
  if (state === 'retryable_failure') return 'Needs Attention';
  if (state === 'dead_letter') return 'Needs Attention';
  if (state === 'conflict') return 'Conflict';
  if (state === 'approved') return 'Approved';
  if ((state === 'rejected' || state === 'suppressed') && normalized(item.decisionAction) === 'deleted') return 'Dismissed';
  if (state === 'rejected' || state === 'suppressed') return 'Rejected';
  if (!state && normalized(item.status) === 'pending') return 'Ready for Review';
  return String(item.status || 'Preparing');
}

/** True while queue/media work is still in flight and approval must stay disabled. */
export function supplierReviewIsPreparing(item: ReviewPresentationItem): boolean {
  const state = normalized(item.queueState);
  return state === 'queued' || state === 'leased' || state === 'processing';
}

export interface SupplierReviewRawMetadata {
  supplierCategory: string;
  supplierSubcategory: string;
  supplierBrand: string;
}

/** A2Z unset brand/category FKs often arrive as "-1" / "0". */
const isSupplierSentinelLabel = (value: string): boolean => (
  /^(?:-1|0|null|undefined|n\/?a|none)$/iu.test(value.trim())
);

const FIELD_REASON_MESSAGES: Record<string, string> = {
  category: 'Select an active product category.',
  brand: 'Select an active registered brand.',
  images: 'Managed publishable image is not ready.',
  subcategory: 'Select an active product subcategory.',
};

/** Preserves raw supplier taxonomy/brand for operators without inventing Zyro mappings. */
export function supplierReviewRawMetadata(item: {
  supplierSnapshot?: Record<string, unknown> | null;
  categoryMapping?: { supplierCategory?: unknown } | null;
  brandMapping?: { supplierBrand?: unknown } | null;
  productPayload?: { brand?: unknown; specs?: Record<string, unknown> } | null;
}): SupplierReviewRawMetadata {
  const snapshot = item.supplierSnapshot || {};
  const hierarchy = Array.isArray(snapshot.categoryHierarchy)
    ? snapshot.categoryHierarchy.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const supplierCategory = String(
    item.categoryMapping?.supplierCategory
    || snapshot.supplierCategory
    || hierarchy[0]
    || '',
  ).trim();
  const supplierSubcategory = String(
    snapshot.supplierSubcategory
    || hierarchy[1]
    || '',
  ).trim();
  const specs = item.productPayload?.specs && typeof item.productPayload.specs === 'object'
    ? item.productPayload.specs
    : {};
  const supplierBrand = String(
    item.brandMapping?.supplierBrand
    || snapshot.brand
    || item.productPayload?.brand
    || specs.brand
    || specs.Brand
    || '',
  ).trim();
  return {
    supplierCategory: supplierCategory || '',
    supplierSubcategory: supplierSubcategory || '',
    // Show Not supplied rather than a fake brand for sentinel FK values.
    supplierBrand: isSupplierSentinelLabel(supplierBrand) ? '' : supplierBrand,
  };
}

/** One clear operator-facing reason per issue (dedupes field codes vs error messages). */
export function supplierReviewOperatorProblems(item: SupplierReviewQuickApprovalItem & {
  mediaFailures?: Array<{ reason?: string; retryable?: boolean }> | null;
}): string[] {
  const validation = item.productValidation || {};
  const missingFields = Array.isArray(validation.missingFields)
    ? validation.missingFields.map((field) => String(field || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const errors = Array.isArray(validation.errors) ? validation.errors : [];
  const reasons = new Map<string, string>();

  const remember = (key: string, message: string) => {
    const normalizedKey = key.trim().toLowerCase();
    const text = message.trim();
    if (!normalizedKey || !text) return;
    if (!reasons.has(normalizedKey)) reasons.set(normalizedKey, text);
  };

  const mediaReasonForState = (fallback: string): string => {
    const queueState = normalized(item.queueState);
    if (queueState === 'dead_letter') {
      return 'Image processing failed permanently. Use Retry media to re-queue.';
    }
    if (queueState === 'retryable_failure' || /will be retried/i.test(fallback)) {
      return 'Image processing failed — retrying automatically';
    }
    return fallback || FIELD_REASON_MESSAGES.images;
  };

  for (const error of errors) {
    const record = error && typeof error === 'object' ? error as { field?: unknown; code?: unknown; message?: unknown } : {};
    const field = String(record.field || '').trim().toLowerCase();
    const code = String(record.code || '').trim().toLowerCase();
    const message = String(record.message || '').trim();
    if (code === 'managed_media_required' || field === 'images') {
      remember('images', mediaReasonForState(message));
      continue;
    }
    if (field && FIELD_REASON_MESSAGES[field]) {
      remember(field, FIELD_REASON_MESSAGES[field]);
      continue;
    }
    if (message) remember(code || field || message.toLowerCase(), message);
  }

  for (const field of missingFields) {
    remember(field, FIELD_REASON_MESSAGES[field] || `Complete required field: ${field}.`);
  }

  if (supplierReviewIsConflict(item)) remember('conflict', 'Conflict requires administrator resolution.');
  if (supplierReviewIsRemoval(item)) remember('removal', 'Supplier removal requires administrator resolution.');
  // Stale revision messaging only applies to decisionable review_pending items.
  if (normalized(item.queueState) === 'review_pending' && supplierReviewIsStale(item)) {
    remember('stale', 'Review revision is stale or missing. Reload before deciding.');
  }

  const hasManagedImage = Boolean(supplierReviewManagedImageUrl(item as SupplierReviewQuickApprovalItem));
  if (!hasManagedImage && !reasons.has('images')) {
    remember('images', mediaReasonForState(FIELD_REASON_MESSAGES.images));
  }

  return [...reasons.values()];
}

/** Storefront publication state for review cards — never imply live visibility before approval. */
export function supplierReviewStorefrontLabel(item: ReviewPresentationItem, draftIsActive: boolean): string {
  const status = normalized(item.status);
  const decision = normalized(item.decisionAction);
  const approved = status === 'approved' || decision === 'approved';
  if (!approved) return 'Not published';
  return draftIsActive ? 'Visible' : 'Hidden';
}

export function supplierReviewCanRetryMedia(item: ReviewPresentationItem): boolean {
  return normalized(item.queueState) === 'dead_letter';
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

const isTerminalReviewDecision = (item: ReviewPresentationItem): boolean => (
  isApproved(item)
  || normalized(item.status) === 'rejected'
  || ['rejected', 'suppressed'].includes(normalized(item.queueState))
);

export function matchesProductReviewFilter(item: ReviewPresentationItem, filter: ProductReviewFilter): boolean {
  const comparisonStatus = normalized(item.comparison?.comparisonStatus);
  if (filter === 'approved_history') return isTerminalReviewDecision(item);
  if (filter === 'conflicts') return isConflict(item);
  if (filter === 'removed_products') return isRemovedChange(comparisonStatus);
  if (filter === 'new_products') return comparisonStatus === 'new_product';
  if (filter === 'needs_attention') {
    return item.productValidation?.readyToPublish === false
      || (item.productValidation?.missingFields?.length || 0) > 0
      || (item.productValidation?.errors?.length || 0) > 0
      || ['failed', 'partial'].includes(normalized(item.mediaStatus))
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
  const lastError = normalized(source.lastError);
  if (lastError && lastError !== 'none') return 'Needs attention';
  if (normalized(source.connectionStatus) === 'connected') return 'Healthy';
  return 'Not checked';
}

export type SupplierConnectionState = 'connected' | 'syncing' | 'paused' | 'disabled' | 'problem';

export interface SupplierConnectionPresentation {
  state: SupplierConnectionState;
  label: 'Connected' | 'Syncing' | 'Paused' | 'Disabled' | 'Connection Problem';
}

/** One presentation-only connection state shared by every Supplier Hub screen. */
export function supplierConnectionPresentation(
  source: Record<string, unknown> | null | undefined,
  isSyncing = false,
): SupplierConnectionPresentation {
  const record = source || {};
  const enabled = record.enabled !== false && record.isEnabled !== false;
  const operationalState = normalized(record.operationalState);
  const sourceStatus = normalized(record.sourceStatus || record.status);
  const connectionStatus = normalized(record.connectionStatus);
  const syncStatus = normalized(record.syncStatus || record.catalogSyncStatus);

  if (!enabled || sourceStatus === 'disabled' || sourceStatus === 'inactive') {
    return { state: 'disabled', label: 'Disabled' };
  }
  if (operationalState === 'paused' || sourceStatus === 'paused') {
    return { state: 'paused', label: 'Paused' };
  }
  if (isSyncing || sourceStatus === 'syncing' || syncStatus === 'syncing' || syncStatus === 'running') {
    return { state: 'syncing', label: 'Syncing' };
  }
  if (connectionStatus === 'connected') return { state: 'connected', label: 'Connected' };
  return { state: 'problem', label: 'Connection Problem' };
}

export function supplierReviewApiState(filter: ProductReviewFilter): 'active' | 'conflict' | 'history' {
  if (filter === 'approved_history') return 'history';
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
