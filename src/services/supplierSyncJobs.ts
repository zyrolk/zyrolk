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
    phase: string;
    percent: number;
    completedSources: number;
    totalSources: number;
    currentSourceId: string | null;
    pagesProcessed: number;
    productsDiscovered: number;
    productsScanned: number;
    productsQueued: number;
    productsFailed: number;
    elapsedMs: number;
    etaMs: number | null;
    etaAt: string | null;
    updatedAt: string;
  };
}

export const isSupplierSyncJobActive = (job: SupplierSyncJobView | null | undefined): boolean => (
  job?.state === 'pending' || job?.state === 'running' || job?.state === 'waiting'
);

export const supplierSyncJobStateLabel = (state: SupplierSyncJobState): string => ({
  pending: 'Pending',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
})[state];

export const formatSupplierSyncEta = (etaMs: number | null | undefined): string => {
  if (etaMs === null || etaMs === undefined || !Number.isFinite(etaMs) || etaMs < 0) return 'Calculating ETA';
  if (etaMs < 60_000) return 'Less than a minute remaining';
  const minutes = Math.max(1, Math.ceil(etaMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'} remaining`;
};
