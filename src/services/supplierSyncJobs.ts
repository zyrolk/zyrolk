export const SUPPLIER_SYNC_JOB_STATES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const;

export type SupplierSyncJobState = typeof SUPPLIER_SYNC_JOB_STATES[number];

export interface SupplierSyncJobView {
  id: string;
  state: SupplierSyncJobState;
  trigger: 'manual' | 'scheduled';
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  nextAttemptAt?: string | null;
  retryCount: number;
  retryLimit: number;
  resumeCount: number;
  cancellationRequestedAt?: string | null;
  lastFailureReason?: string | null;
  waitingReason?: string | null;
  progress: {
    modelVersion?: 2;
    determination?: 'determinate' | 'indeterminate';
    basis?: 'catalog_total' | 'limit_upper_bound' | 'unknown' | 'completed';
    phase: string;
    percent: number;
    completedSources: number;
    totalSources: number;
    currentSourceId: string | null;
    pagesProcessed: number;
    productsDiscovered: number;
    productsObserved?: number;
    productsScanned: number;
    productsQueued: number;
    productsFailed: number;
    totalProducts?: number | null;
    totalProductsReliability?: 'exact' | 'reported' | 'unknown';
    elapsedMs: number;
    activeElapsedMs?: number;
    etaMs: number | null;
    etaAt: string | null;
    updatedAt: string;
  };
}

export const isSupplierSyncJobActive = (job: SupplierSyncJobView | null | undefined): boolean => (
  job?.state === 'pending' || job?.state === 'running' || job?.state === 'waiting'
);

const syncJobTime = (value: string | null | undefined, fallback: number): number => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Prefer the job that owns the worker lease over a newer job waiting behind it.
 * Pending/waiting jobs then follow dispatcher order; with no active work, show
 * the newest terminal result.
 */
export const selectSupplierSyncJobForDisplay = (
  jobs: readonly SupplierSyncJobView[],
): SupplierSyncJobView | null => {
  const candidates = jobs.filter((job) => Boolean(job?.id));
  if (candidates.length === 0) return null;

  const running = candidates
    .filter((job) => job.state === 'running')
    .sort((left, right) => syncJobTime(left.startedAt, Number.MAX_SAFE_INTEGER)
      - syncJobTime(right.startedAt, Number.MAX_SAFE_INTEGER));
  if (running[0]) return running[0];

  const queued = candidates
    .filter(isSupplierSyncJobActive)
    .sort((left, right) => {
      const nextAttemptDifference = syncJobTime(left.nextAttemptAt, 0) - syncJobTime(right.nextAttemptAt, 0);
      if (nextAttemptDifference !== 0) return nextAttemptDifference;
      return syncJobTime(left.createdAt, 0) - syncJobTime(right.createdAt, 0);
    });
  if (queued[0]) return queued[0];

  return [...candidates].sort((left, right) => syncJobTime(right.createdAt, 0) - syncJobTime(left.createdAt, 0))[0];
};

export const supplierSyncJobStateLabel = (state: SupplierSyncJobState): string => ({
  pending: 'Pending',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
})[state];

export const formatSupplierSyncEta = (etaMs: number | null | undefined): string => {
  if (etaMs === null || etaMs === undefined || !Number.isFinite(etaMs) || etaMs < 0) return 'Time remaining unavailable';
  if (etaMs < 60_000) return 'Less than a minute remaining';
  const minutes = Math.max(1, Math.ceil(etaMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'} remaining`;
};

export const isSupplierSyncProgressDeterminate = (job: SupplierSyncJobView): boolean => (
  job.progress.determination === 'determinate'
  && (job.progress.basis === 'completed'
    || (job.progress.basis === 'catalog_total'
      && job.progress.totalProductsReliability === 'exact'
      && Number.isFinite(job.progress.totalProducts)
      && Number(job.progress.totalProducts) > 0))
);

export const formatSupplierSyncProgress = (job: SupplierSyncJobView): string => {
  const label = supplierSyncJobStateLabel(job.state);
  const { pagesProcessed, percent, productsQueued, productsScanned } = job.progress;
  if (!isSupplierSyncJobActive(job)) {
    return `${label} · ${productsScanned} scanned · ${productsQueued} queued`;
  }

  const determinate = isSupplierSyncProgressDeterminate(job);
  const progressLabel = determinate
    ? `${percent}%`
    : pagesProcessed > 0 || productsScanned > 0
      ? 'In progress'
      : 'Starting';
  const etaLabel = determinate && job.progress.etaMs !== null
    ? ` · ${formatSupplierSyncEta(job.progress.etaMs)}`
    : '';
  return `${label} · ${progressLabel} · ${productsScanned} scanned${etaLabel}`;
};
