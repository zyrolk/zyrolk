export type SupplierReviewMediaState =
  | 'READY'
  | 'PROCESSING'
  | 'RETRY_SCHEDULED'
  | 'NEEDS_ATTENTION'
  | 'SUPPLIER_IMAGE_UNAVAILABLE'
  | 'PERMANENT_MEDIA_CONSTRAINT'
  | 'LEGACY_UNKNOWN';

export type SupplierReviewMediaAgeClass = 'fresh' | 'aging' | 'stale' | null;

export interface SupplierReviewMediaEvidence {
  state: SupplierReviewMediaState;
  rawState?: string;
  readiness?: 'ready' | 'blocked' | 'unknown';
  sourceImageCount?: number | null;
  managedImageCount?: number | null;
  hasUsablePrimary?: boolean | null;
  blockingIssueCount?: number | null;
  retryCount?: number | null;
  nextRetryAt?: string | null;
  lastActivityAt?: string | null;
  processingStartedAt?: string | null;
  mediaAgeSeconds?: number | null;
  processingAgeSeconds?: number | null;
  ageClass?: SupplierReviewMediaAgeClass;
  possiblyStuck?: boolean;
  safeFailureClass?: string;
  legacy?: boolean;
}

const fallbackEvidence = (item: {
  queueState?: unknown;
  mediaStatus?: unknown;
  mediaReadiness?: unknown;
  managedMedia?: unknown;
  mediaFailures?: unknown;
}): SupplierReviewMediaEvidence => {
  const queueState = String(item.queueState || '').trim().toLowerCase();
  const mediaStatus = String(item.mediaStatus || '').trim().toLowerCase();
  const mediaReadiness = String(item.mediaReadiness || '').trim().toLowerCase();
  if (mediaReadiness.startsWith('publication_safe') || mediaReadiness === 'ready' || mediaStatus === 'ready') {
    return { state: 'READY', readiness: 'ready', legacy: false };
  }
  if (['queued', 'leased', 'processing'].includes(queueState) || ['queued', 'downloading', 'processing'].includes(mediaStatus)) {
    return { state: 'PROCESSING', readiness: 'blocked', legacy: false };
  }
  if (mediaStatus || item.mediaFailures || item.managedMedia) {
    return { state: 'NEEDS_ATTENTION', readiness: 'blocked', legacy: false };
  }
  return { state: 'LEGACY_UNKNOWN', readiness: 'unknown', legacy: true };
};

export function supplierReviewMediaEvidence(item: {
  media?: SupplierReviewMediaEvidence;
  queueState?: unknown;
  mediaStatus?: unknown;
  mediaReadiness?: unknown;
  managedMedia?: unknown;
  mediaFailures?: unknown;
}): SupplierReviewMediaEvidence {
  return item.media && typeof item.media.state === 'string' ? item.media : fallbackEvidence(item);
}

export function supplierReviewMediaLabel(state: SupplierReviewMediaState): string {
  switch (state) {
    case 'READY': return 'Ready for review';
    case 'PROCESSING': return 'Processing media';
    case 'RETRY_SCHEDULED': return 'Retry scheduled';
    case 'NEEDS_ATTENTION': return 'Media needs attention';
    case 'SUPPLIER_IMAGE_UNAVAILABLE': return 'Supplier image unavailable';
    case 'PERMANENT_MEDIA_CONSTRAINT': return 'Permanent media constraint';
    default: return 'Media status unavailable';
  }
}

export function supplierReviewMediaAgeLabel(evidence: SupplierReviewMediaEvidence): string | null {
  const seconds = evidence.processingAgeSeconds ?? evidence.mediaAgeSeconds;
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

export function supplierReviewMediaRetryLabel(evidence: SupplierReviewMediaEvidence): string | null {
  if (!evidence.nextRetryAt) return null;
  const retryAt = Date.parse(evidence.nextRetryAt);
  if (!Number.isFinite(retryAt)) return null;
  const remainingMinutes = Math.max(0, Math.ceil((retryAt - Date.now()) / 60000));
  return remainingMinutes > 0 ? `Retry in ${remainingMinutes}m` : 'Retry due';
}
