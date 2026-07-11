import type {
  SupplierHealth,
  SupplierMetrics,
  SupplierSnapshot,
  SupplierSnapshotQueueItem,
  SupplierSnapshotSource,
  SupplierSnapshotSync,
  SupplierTimestampSummary,
} from '../types/supplier';

const DAY_MS = 86_400_000;

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object);
  });
  return Object.freeze(value);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function supplierKeys(supplier: SupplierSnapshotSource): readonly string[] {
  return [supplier.id, supplier.name].map(normalize).filter(Boolean);
}

function syncMatchesSupplier(sync: SupplierSnapshotSync, supplier: SupplierSnapshotSource): boolean {
  const keys = supplierKeys(supplier);
  return [sync.supplierId, sync.supplierName].map(normalize).some((value) => value && keys.includes(value));
}

function queueMatchesSupplier(item: SupplierSnapshotQueueItem, supplier: SupplierSnapshotSource): boolean {
  const keys = supplierKeys(supplier);
  return [item.supplierId, item.supplierName].map(normalize).some((value) => value && keys.includes(value));
}

function isPending(status: string): boolean {
  return normalize(status) === 'pending';
}

function absoluteTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function relativeTimestamp(date: Date, asOf: Date): string {
  const elapsed = Math.max(0, asOf.getTime() - date.getTime());
  const days = Math.floor(elapsed / DAY_MS);
  if (days === 0) {
    const hours = Math.floor(elapsed / 3_600_000);
    return hours === 0 ? 'Less than 1 hour ago' : `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function timestampSummary(date: Date, asOf: Date): SupplierTimestampSummary {
  return { iso: date.toISOString(), absolute: absoluteTimestamp(date), relative: relativeTimestamp(date, asOf) };
}

function buildSupplierHealth(
  supplier: SupplierSnapshotSource,
  history: readonly SupplierSnapshotSync[],
  pendingApprovals: number,
  asOf: Date,
): SupplierHealth {
  const validHistory = history
    .map((entry) => ({ entry, date: parseDate(entry.timestamp) }))
    .filter((item): item is { entry: SupplierSnapshotSync; date: Date } => item.date !== null)
    .sort((left, right) => right.date.getTime() - left.date.getTime());

  if (validHistory.length === 0) {
    return {
      supplierId: supplier.id, supplierName: supplier.name, status: 'unavailable', label: 'Unavailable',
      reasons: ['No valid sync history is available for this enabled supplier.'], successRate: null,
      pendingApprovals, lastSuccessfulSync: null,
    };
  }

  const knownRuns = validHistory.filter(({ entry }) => entry.status === 'success' || entry.status === 'failed');
  const successes = knownRuns.filter(({ entry }) => entry.status === 'success');
  const failures = knownRuns.filter(({ entry }) => entry.status === 'failed');
  const latest = validHistory[0];
  const latestSuccess = successes[0] || null;
  const successRate = knownRuns.length > 0 ? (successes.length / knownRuns.length) * 100 : null;
  const ageDays = latestSuccess ? Math.max(0, (asOf.getTime() - latestSuccess.date.getTime()) / DAY_MS) : null;
  const criticalReasons: string[] = [];
  const attentionReasons: string[] = [];

  if (latest.entry.status === 'failed') criticalReasons.push('The latest recorded sync failed.');
  if (!latestSuccess) criticalReasons.push('No successful sync is recorded.');
  else if (ageDays !== null && ageDays > 7) criticalReasons.push(`The last successful sync is ${Math.floor(ageDays)} days old, exceeding 7 days.`);
  if (pendingApprovals > 20) criticalReasons.push(`${pendingApprovals} approvals are pending, exceeding the large-backlog threshold of 20.`);

  if (ageDays !== null && ageDays > 3 && ageDays <= 7) attentionReasons.push(`The last successful sync is ${Math.floor(ageDays)} days old.`);
  if (failures.length > 0 && latest.entry.status !== 'failed') attentionReasons.push(`${failures.length} failed ${failures.length === 1 ? 'sync is' : 'syncs are'} recorded.`);
  if (pendingApprovals >= 6 && pendingApprovals <= 20) attentionReasons.push(`${pendingApprovals} approvals are pending.`);

  let status: SupplierHealth['status'];
  let reasons: readonly string[];
  if (criticalReasons.length > 0) {
    status = 'critical'; reasons = criticalReasons;
  } else if (attentionReasons.length > 0) {
    status = 'attention'; reasons = attentionReasons;
  } else if (latest.entry.status === 'success' && ageDays !== null && ageDays <= 3 && failures.length === 0 && pendingApprovals <= 5) {
    status = 'healthy';
    reasons = [`The latest sync succeeded within 3 days, no failures are recorded, and the approval backlog is ${pendingApprovals}.`];
  } else {
    status = 'attention'; reasons = ['Available sync facts do not meet every healthy-supplier condition.'];
  }

  return {
    supplierId: supplier.id, supplierName: supplier.name, status,
    label: status === 'healthy' ? 'Healthy' : status === 'critical' ? 'Critical' : 'Needs attention',
    reasons, successRate, pendingApprovals,
    lastSuccessfulSync: latestSuccess ? timestampSummary(latestSuccess.date, asOf) : null,
  };
}

export function buildSupplierMetrics(snapshot: SupplierSnapshot, asOf: Date): SupplierMetrics {
  if (Number.isNaN(asOf.getTime())) throw new RangeError('Supplier metrics require a valid as-of date.');
  const suppliers = [...snapshot.suppliers];
  const enabled = suppliers.filter((supplier) => supplier.isEnabled);
  const pendingReviews = snapshot.reviewQueue.filter((item) => isPending(item.status));
  const pendingChanges = snapshot.pendingChanges.filter((item) => isPending(item.status));
  const validSyncs = snapshot.syncHistory
    .map((entry) => ({ entry, date: parseDate(entry.timestamp) }))
    .filter((item): item is { entry: SupplierSnapshotSync; date: Date } => item.date !== null)
    .sort((left, right) => right.date.getTime() - left.date.getTime());
  const knownSyncs = validSyncs.filter(({ entry }) => entry.status === 'success' || entry.status === 'failed');
  const successfulSyncs = knownSyncs.filter(({ entry }) => entry.status === 'success');
  const failedSyncs = knownSyncs.filter(({ entry }) => entry.status === 'failed');
  const health = enabled.map((supplier) => buildSupplierHealth(
    supplier,
    snapshot.syncHistory.filter((entry) => syncMatchesSupplier(entry, supplier)),
    pendingReviews.filter((item) => queueMatchesSupplier(item, supplier)).length,
    asOf,
  ));
  const backlogHistory = validSyncs.filter(({ entry }) => entry.pendingReviews !== null).slice(0, 2);
  const currentBacklog = backlogHistory[0]?.entry.pendingReviews ?? null;
  const previousBacklog = backlogHistory[1]?.entry.pendingReviews ?? null;
  const difference = currentBacklog !== null && previousBacklog !== null ? currentBacklog - previousBacklog : null;
  const trend = difference === null ? 'unavailable' : difference > 0 ? 'increased' : difference < 0 ? 'decreased' : 'unchanged';
  const trendMessage = difference === null
    ? 'Backlog trend is unavailable because two sync records with backlog counts are not present.'
    : `Approval backlog ${trend} by ${Math.abs(difference)} compared with the previous recorded sync.`;
  const lastSuccess = successfulSyncs[0] || null;
  const healthy = health.filter((item) => item.status === 'healthy')
    .sort((left, right) => (right.successRate || 0) - (left.successRate || 0) || left.supplierName.localeCompare(right.supplierName));
  const attention = health.filter((item) => item.status !== 'healthy')
    .sort((left, right) => (left.status === 'critical' ? -1 : right.status === 'critical' ? 1 : 0) || left.supplierName.localeCompare(right.supplierName));

  const metrics: SupplierMetrics = {
    hasSuppliers: suppliers.length > 0,
    asOf: asOf.toISOString(),
    totalSuppliers: suppliers.length,
    enabledSuppliers: enabled.length,
    disabledSuppliers: suppliers.length - enabled.length,
    healthySuppliers: healthy.length,
    suppliersRequiringAttention: attention.length,
    sync: {
      totalSyncs: validSyncs.length,
      successfulSyncs: successfulSyncs.length,
      failedSyncs: failedSyncs.length,
      unknownSyncs: validSyncs.length - knownSyncs.length,
      successRate: knownSyncs.length > 0 ? (successfulSyncs.length / knownSyncs.length) * 100 : null,
      lastSuccessfulSync: lastSuccess ? timestampSummary(lastSuccess.date, asOf) : null,
    },
    queues: {
      pendingReviews: pendingReviews.length,
      pendingChanges: pendingChanges.length,
      approvalBacklog: pendingReviews.length,
      backlogTrend: { direction: trend, current: currentBacklog, previous: previousBacklog, absoluteChange: difference, message: trendMessage },
    },
    supplierHealth: health,
    topHealthySuppliers: healthy.slice(0, 5),
    attentionSuppliers: attention,
  };
  return deepFreeze(metrics) as SupplierMetrics;
}
