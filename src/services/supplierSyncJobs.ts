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

export const isSupplierSyncJobTerminal = (job: SupplierSyncJobView | null | undefined): boolean => (
  job?.state === 'completed' || job?.state === 'failed' || job?.state === 'cancelled'
);

const syncJobTime = (value: string | null | undefined, fallback: number): number => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sortActiveSupplierSyncJobs = (jobs: readonly SupplierSyncJobView[]): SupplierSyncJobView[] => (
  jobs
    .filter(isSupplierSyncJobActive)
    .sort((left, right) => {
      if (left.state === 'running' && right.state !== 'running') return -1;
      if (right.state === 'running' && left.state !== 'running') return 1;
      const nextAttemptDifference = syncJobTime(left.nextAttemptAt, 0) - syncJobTime(right.nextAttemptAt, 0);
      if (nextAttemptDifference !== 0) return nextAttemptDifference;
      return syncJobTime(left.createdAt, 0) - syncJobTime(right.createdAt, 0);
    })
);

/** Active queued/running/waiting job, if any. */
export const selectCurrentSupplierSyncJob = (
  jobs: readonly SupplierSyncJobView[],
): SupplierSyncJobView | null => sortActiveSupplierSyncJobs(jobs)[0] ?? null;

/** Newest terminal job when no active work exists. */
export const selectLastTerminalSupplierSyncJob = (
  jobs: readonly SupplierSyncJobView[],
): SupplierSyncJobView | null => {
  const terminals = jobs
    .filter(isSupplierSyncJobTerminal)
    .sort((left, right) => syncJobTime(right.createdAt, 0) - syncJobTime(left.createdAt, 0));
  return terminals[0] ?? null;
};

export const selectSupplierSyncJobViews = (
  jobs: readonly SupplierSyncJobView[],
): { current: SupplierSyncJobView | null; last: SupplierSyncJobView | null } => {
  const current = selectCurrentSupplierSyncJob(jobs);
  const last = selectLastTerminalSupplierSyncJob(
    jobs.filter((job) => !current || job.id !== current.id),
  );
  return { current, last };
};

/**
 * Prefer the job that owns the worker lease over a newer job waiting behind it.
 * Pending/waiting jobs then follow dispatcher order; with no active work, show
 * the newest terminal result.
 */
export const selectSupplierSyncJobForDisplay = (
  jobs: readonly SupplierSyncJobView[],
): SupplierSyncJobView | null => (
  selectCurrentSupplierSyncJob(jobs) ?? selectLastTerminalSupplierSyncJob(jobs)
);

export const supplierSyncJobStateLabel = (state: SupplierSyncJobState): string => ({
  pending: 'Pending',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
})[state];

/** One operator-facing sync headline that never combines contradictory states. */
export const supplierSyncJobHeadline = (job: SupplierSyncJobView): string => {
  const { productsScanned, pagesProcessed } = job.progress;
  if (isSupplierSyncJobActive(job) && (job.state === 'running' || pagesProcessed > 0 || productsScanned > 0)) {
    return `Sync in progress · ${productsScanned} scanned`;
  }
  if (job.state === 'waiting') return 'Sync waiting to continue';
  if (job.state === 'pending') return 'Sync pending';
  if (job.state === 'completed' && productsScanned === 0) {
    return 'Catalog update · Completed with no new products scanned';
  }
  return `Catalog update · ${supplierSyncJobStateLabel(job.state)}`;
};

/** Secondary sync detail line derived from persisted counters only. */
export const supplierSyncJobDetailLine = (job: SupplierSyncJobView): string => {
  const { productsQueued, productsScanned, percent, etaMs } = job.progress;
  const determinate = isSupplierSyncProgressDeterminate(job);
  const parts: string[] = [];

  if (job.state === 'running') {
    parts.push(determinate ? `${percent}% complete` : 'Scanning supplier catalogue');
  } else if (job.state === 'waiting') {
    const reason = String(job.waitingReason || '').trim();
    parts.push(reason ? `Waiting: ${reason}` : 'Waiting to retry supplier work');
  } else if (job.state === 'pending') {
    parts.push('Waiting to start');
  }

  parts.push(`${productsScanned} scanned · ${productsQueued} queued for processing`);

  if (isSupplierSyncJobActive(job) && determinate && etaMs !== null) {
    parts.push(formatSupplierSyncEta(etaMs));
  }

  return parts.join(' · ');
};

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
  const headline = supplierSyncJobHeadline(job);
  const detail = supplierSyncJobDetailLine(job);
  return detail ? `${headline} · ${detail}` : headline;
};
