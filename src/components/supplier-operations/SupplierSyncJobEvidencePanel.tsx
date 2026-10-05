import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Database, ShieldCheck } from 'lucide-react';
import { formatSupplierTimestamp } from '../../services/supplierHubPresentation';
import { supplierSyncJobStateLabel, SupplierSyncJobState } from '../../services/supplierSyncJobs';

export type SupplierEvidenceApiRequest = (path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => Promise<Response>;

type CounterSet = {
  scanned: number;
  processed: number;
  queued: number;
  new: number;
  changeCandidates: number;
  unchanged: number;
  rejected: number | null;
  failed: number;
  warnings: number;
  pages: number;
};

type CursorMap = Record<string, string | null>;

export type SupplierSyncEvidenceIssue = {
  category: string;
  message: string;
  attemptId?: string;
  pageCommitId?: string;
};

export type SupplierSyncEvidenceGroup = {
  key: 'supplierData' | 'adminReview' | 'media' | 'system';
  label: string;
  available: boolean;
  issues: SupplierSyncEvidenceIssue[];
};

export type SupplierSyncAttemptEvidence = {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  kind: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  cursorBefore: CursorMap;
  cursorAfter: CursorMap;
  requestedTotalProductLimit: number | null;
  effectiveTotalProductLimit: number | null;
  requestedPageSize: number | null;
  effectivePageSize: Record<string, number>;
  remainingLimitAtStart: Record<string, number | null>;
  counters: CounterSet;
  stopReason: string | null;
  errorClass: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  retryable: boolean | null;
};

export type SupplierSyncEvidenceModel = {
  evidenceVersion: number | null;
  legacy: boolean;
  attempts: SupplierSyncAttemptEvidence[];
  reconciliation: {
    status: 'VERIFIED' | 'ISSUES' | 'LEGACY_UNVERIFIED';
    issues: SupplierSyncEvidenceIssue[];
    attemptCount: number;
    pageCommitCount: number;
    cumulativeCounters: CounterSet | null;
    reconciledAt: string;
  };
  issueGroups: SupplierSyncEvidenceGroup[];
};

export type SupplierSyncEvidenceJob = {
  id: string;
  state: SupplierSyncJobState | string;
  trigger?: string;
  sourceIds?: string[];
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
  requestedTotalProductLimit?: number | null;
  effectiveTotalProductLimit?: number | null;
  requestedPageSize?: number | null;
  effectivePageSize?: Record<string, number> | null;
  initialCursor?: CursorMap | null;
  durableCursor?: CursorMap | null;
  finalCursor?: CursorMap | null;
  attemptCount?: number | null;
  resumeCount?: number | null;
  cumulativeCounters?: CounterSet | null;
  reconciliationStatus?: string | null;
  stopReason?: string | null;
};

export type SupplierSyncEvidenceResponse = {
  success?: boolean;
  job?: SupplierSyncEvidenceJob;
  evidence?: SupplierSyncEvidenceModel;
  error?: string;
};

const NOT_RECORDED = 'Not recorded';

export function supplierSyncReconciliationLabel(status: string | null | undefined): string {
  if (status === 'VERIFIED') return 'Verified';
  if (status === 'ISSUES') return 'Needs attention';
  if (status === 'LEGACY_UNVERIFIED') return 'Legacy — evidence incomplete';
  return NOT_RECORDED;
}

export function supplierSyncReconciliationHelp(status: string | null | undefined): string {
  if (status === 'VERIFIED') return 'Counts, cursor chain, attempts, limits, and outcomes reconcile.';
  if (status === 'LEGACY_UNVERIFIED') return 'This job predates immutable attempt evidence and cannot be fully verified.';
  if (status === 'ISSUES') return 'One or more durable evidence checks need attention.';
  return 'Reconciliation evidence is not recorded for this job.';
}

export function formatSupplierEvidenceMap(values: CursorMap | Record<string, number | null> | null | undefined): string {
  if (!values || Object.keys(values).length === 0) return NOT_RECORDED;
  return Object.entries(values).map(([sourceId, value]) => `${sourceId}: ${value === null || value === '' ? '<start>' : String(value)}`).join(' · ');
}

export function supplierSyncEvidenceDuration(start: string | null | undefined, end: string | null | undefined): string {
  const startMs = Date.parse(String(start || ''));
  const endMs = Date.parse(String(end || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return NOT_RECORDED;
  const seconds = Math.round((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

const counterRows: Array<[keyof CounterSet, string]> = [
  ['scanned', 'Scanned'],
  ['processed', 'Processed'],
  ['queued', 'Queued'],
  ['new', 'New'],
  ['changeCandidates', 'Change candidates'],
  ['unchanged', 'Unchanged'],
  ['rejected', 'Rejected'],
  ['failed', 'Failed'],
  ['warnings', 'Warnings'],
  ['pages', 'Pages'],
];

const displayCount = (value: number | null | undefined): string => value === null || value === undefined ? NOT_RECORDED : String(value);
const displayDate = (value: string | null | undefined): string => value ? formatSupplierTimestamp(value) : NOT_RECORDED;
const statusClass = (status: string): string => {
  if (status === 'VERIFIED' || status === 'completed' || status === 'committed') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300';
  if (status === 'ISSUES' || status === 'failed') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300';
  if (status === 'LEGACY_UNVERIFIED') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300';
  return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300';
};

const cardClass = 'rounded-2xl border border-slate-200/70 bg-white p-4 dark:border-slate-800 dark:bg-slate-950';

export default function SupplierSyncJobEvidencePanel({
  requestApi,
  jobId,
  onClose,
  onOpenProductReview,
}: {
  requestApi: SupplierEvidenceApiRequest;
  jobId: string;
  onClose?: () => void;
  onOpenProductReview?: (jobId: string) => void;
}) {
  const [job, setJob] = useState<SupplierSyncEvidenceJob | null>(null);
  const [evidence, setEvidence] = useState<SupplierSyncEvidenceModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setJob(null);
    setEvidence(null);
    void requestApi(`/api/supplier-sync/jobs/${encodeURIComponent(jobId)}?evidence=true`, 'GET')
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as SupplierSyncEvidenceResponse;
        if (!response.ok || result.success === false || !result.job) throw new Error(result.error || 'Supplier job evidence could not be loaded.');
        if (cancelled) return;
        setJob(result.job);
        setEvidence(result.evidence || null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Supplier job evidence could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [jobId, requestApi]);

  if (loading) return <section aria-label="Loading supplier job evidence" className={cardClass}><p className="text-sm font-semibold text-slate-500">Loading job evidence…</p></section>;
  if (error || !job) return <section aria-label="Supplier job evidence error" className={`${cardClass} border-red-200 dark:border-red-900/60`}><div className="flex items-start justify-between gap-3"><p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">{error || 'Supplier job evidence was not found.'}</p>{onClose && <button type="button" onClick={onClose} className="min-h-9 rounded-lg bg-slate-100 px-3 text-[10px] font-black dark:bg-slate-800">Close</button>}</div></section>;

  const reconciliationStatus = evidence?.reconciliation.status || job.reconciliationStatus || null;
  const counters = evidence?.reconciliation.cumulativeCounters || job.cumulativeCounters || null;
  const legacyEvidence = evidence?.legacy === true || reconciliationStatus === 'LEGACY_UNVERIFIED';
  const attempts = legacyEvidence ? [] : (evidence?.attempts || []);
  const durationEnd = job.finishedAt || job.updatedAt || null;
  const attemptCount = legacyEvidence ? null : (evidence?.reconciliation.attemptCount ?? job.attemptCount ?? null);

  return (
    <section aria-labelledby="supplier-job-evidence-title" className={`${cardClass} space-y-5`} data-testid="supplier-sync-job-evidence">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Database className="h-5 w-5 text-blue-500" aria-hidden="true" />
            <h4 id="supplier-job-evidence-title" className="font-black text-slate-900 dark:text-white">Job evidence</h4>
            <span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase ${statusClass(String(job.state))}`}>{supplierSyncJobStateLabel(job.state as SupplierSyncJobState) || job.state}</span>
            <span title={supplierSyncReconciliationHelp(reconciliationStatus)} className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase ${statusClass(String(reconciliationStatus || 'unknown'))}`}>{supplierSyncReconciliationLabel(reconciliationStatus)}</span>
          </div>
          <p className="mt-2 break-all text-[10px] font-mono text-slate-400">{job.id}</p>
          <p className="mt-1 text-xs text-slate-500">{job.sourceIds?.join(', ') || NOT_RECORDED} · {job.trigger || NOT_RECORDED} · {displayDate(job.startedAt || job.createdAt)} → {displayDate(job.finishedAt)}</p>
          {legacyEvidence && <p className="mt-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">Aggregate fields are shown from legacy durable evidence; attempt-level details are not recorded.</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {onOpenProductReview && <button type="button" onClick={() => onOpenProductReview(job.id)} className="min-h-9 rounded-lg bg-blue-600 px-3 text-[10px] font-black text-white">Open Product Review</button>}
          {onClose && <button type="button" onClick={onClose} className="min-h-9 rounded-lg bg-slate-100 px-3 text-[10px] font-black text-slate-700 dark:bg-slate-800 dark:text-slate-200">Close</button>}
        </div>
      </div>

      <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Started</p><p className="mt-1 font-semibold">{displayDate(job.startedAt || job.createdAt)}</p></div>
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Completed</p><p className="mt-1 font-semibold">{displayDate(job.finishedAt)}</p></div>
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Duration</p><p className="mt-1 font-semibold">{supplierSyncEvidenceDuration(job.startedAt || job.createdAt, durationEnd)}</p></div>
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Attempts</p><p className="mt-1 font-semibold">{displayCount(attemptCount)}</p></div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section aria-labelledby="supplier-job-limits-title" className="rounded-2xl border border-slate-200/70 p-4 dark:border-slate-800">
          <h5 id="supplier-job-limits-title" className="flex items-center gap-2 text-xs font-black text-slate-900 dark:text-white"><ShieldCheck className="h-4 w-4 text-blue-500" aria-hidden="true" /> Limits</h5>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><span>Requested limit: <strong>{displayCount(job.requestedTotalProductLimit)}</strong></span><span>Effective limit: <strong>{displayCount(job.effectiveTotalProductLimit)}</strong></span><span>Requested page size: <strong>{displayCount(job.requestedPageSize)}</strong></span><span>Effective page size: <strong>{formatSupplierEvidenceMap(job.effectivePageSize)}</strong></span></div>
        </section>
        <section aria-labelledby="supplier-job-cursor-title" className="rounded-2xl border border-slate-200/70 p-4 dark:border-slate-800">
          <h5 id="supplier-job-cursor-title" className="flex items-center gap-2 text-xs font-black text-slate-900 dark:text-white"><Clock3 className="h-4 w-4 text-blue-500" aria-hidden="true" /> Cursor evidence</h5>
          <div className="mt-3 space-y-2 text-xs"><p>Initial: <strong>{formatSupplierEvidenceMap(job.initialCursor)}</strong></p><p>Durable: <strong>{formatSupplierEvidenceMap(job.durableCursor)}</strong></p><p>Final: <strong>{formatSupplierEvidenceMap(job.finalCursor)}</strong></p></div>
        </section>
      </div>

      <section aria-labelledby="supplier-job-counts-title">
        <h5 id="supplier-job-counts-title" className="mb-3 flex items-center gap-2 text-xs font-black text-slate-900 dark:text-white"><Database className="h-4 w-4 text-violet-500" aria-hidden="true" /> Cumulative counts</h5>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{counterRows.map(([key, label]) => <div key={key} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900"><p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p><p className="mt-1 text-lg font-black text-slate-900 dark:text-white">{displayCount(counters?.[key])}</p></div>)}</div>
      </section>

      <section aria-labelledby="supplier-job-attempts-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h5 id="supplier-job-attempts-title" className="flex items-center gap-2 text-xs font-black text-slate-900 dark:text-white"><CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" /> Attempt timeline</h5><span className="text-[10px] text-slate-400">{attempts.length ? `${attempts.length} durable attempt${attempts.length === 1 ? '' : 's'}` : NOT_RECORDED}</span></div>
        {attempts.length ? <div className="space-y-2">{attempts.map((attempt) => <details key={attempt.attemptId} className="rounded-xl border border-slate-200/70 p-3 dark:border-slate-800"><summary className="cursor-pointer list-none text-xs font-semibold text-slate-800 dark:text-slate-100"><span className="mr-2 font-black">Attempt {attempt.attemptNumber || NOT_RECORDED}</span><span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase ${statusClass(attempt.status)}`}>{attempt.status}</span><span className="ml-2 text-slate-500">{formatSupplierEvidenceMap(attempt.cursorBefore)} → {formatSupplierEvidenceMap(attempt.cursorAfter)} · {displayCount(attempt.counters.scanned)} scanned · {displayCount(attempt.counters.processed)} processed</span></summary><div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-600 dark:border-slate-800 dark:text-slate-300 sm:grid-cols-2 lg:grid-cols-3"><span>Kind: <strong>{attempt.kind || NOT_RECORDED}</strong></span><span>Started: <strong>{displayDate(attempt.startedAt)}</strong></span><span>Completed: <strong>{displayDate(attempt.completedAt)}</strong></span><span>Duration: <strong>{supplierSyncEvidenceDuration(attempt.startedAt, attempt.completedAt)}</strong></span><span>Remaining at start: <strong>{formatSupplierEvidenceMap(attempt.remainingLimitAtStart)}</strong></span><span>Page size: <strong>{formatSupplierEvidenceMap(attempt.effectivePageSize)}</strong></span>{counterRows.map(([key, label]) => <span key={key}>{label}: <strong>{displayCount(attempt.counters[key])}</strong></span>)}<span>Stop reason: <strong>{attempt.stopReason || NOT_RECORDED}</strong></span>{attempt.errorClass && <span>Error class: <strong>{attempt.errorClass}</strong></span>}{attempt.errorCode && <span>Error code: <strong>{attempt.errorCode}</strong></span>}{attempt.errorMessageSafe && <span className="sm:col-span-2 lg:col-span-3">Message: <strong>{attempt.errorMessageSafe}</strong></span>}</div></details>)}</div> : <p className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">No immutable attempt timeline is recorded for this job.</p>}
      </section>

      <section aria-labelledby="supplier-job-issues-title">
        <div className="mb-3 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" /><h5 id="supplier-job-issues-title" className="text-xs font-black text-slate-900 dark:text-white">Issues and review requirements</h5></div>
        <div className="grid gap-2 sm:grid-cols-2">{(evidence?.issueGroups || []).map((group) => <div key={group.key} className="rounded-xl border border-slate-200/70 p-3 dark:border-slate-800"><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{group.label}</span><span className={`rounded-full px-2 py-1 text-[9px] font-black ${group.issues.length ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-900'}`}>{group.issues.length ? group.issues.length : group.available ? 'None recorded' : NOT_RECORDED}</span></div>{group.issues.length > 0 && <ul className="mt-2 space-y-1 text-[11px] text-slate-600 dark:text-slate-300">{group.issues.slice(0, 6).map((issue, index) => <li key={`${issue.category}:${issue.attemptId || issue.pageCommitId || index}`}>{issue.message}</li>)}</ul>}</div>)}</div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[10px] text-slate-500 dark:border-slate-800"><span>Auto-published: {NOT_RECORDED} · Product Review remains a separate approval step.</span><span>Stop reason: {job.stopReason || NOT_RECORDED}</span></div>
    </section>
  );
}
