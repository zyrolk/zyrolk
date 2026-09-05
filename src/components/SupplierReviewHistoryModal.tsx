import React, { useEffect, useRef } from 'react';
import { Clock3, History, X } from 'lucide-react';
import { formatSupplierTimestamp, supplierAdministratorLabel } from '../services/supplierHubPresentation';
import { SupplierReviewFieldChange } from '../services/supplierReviewEditor';

export interface SupplierReviewAuditEvent {
  id: string;
  action?: string;
  previousState?: string | null;
  newState?: string;
  reason?: string;
  timestamp?: unknown;
  adminUserId?: string | null;
  adminEmail?: string | null;
  changedFields?: Record<string, { before?: unknown; after?: unknown }>;
  supplierFieldChanges?: SupplierReviewFieldChange[];
}

interface SupplierReviewHistoryItem {
  id: string;
  productName: string;
  supplierName?: string;
  supplierCode: string;
  decisionAction?: string;
  decisionCompletedAt?: unknown;
  decisionCompletedBy?: unknown;
}

interface SupplierReviewHistoryModalProps {
  item: SupplierReviewHistoryItem;
  events: SupplierReviewAuditEvent[];
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  currentAdmin?: { uid?: unknown; displayName?: unknown; email?: unknown } | null;
  onLoadMore: () => Promise<void>;
  onClose: () => void;
}

const displayValue = (value: unknown): string => {
  if (typeof value === 'string') return value || 'Empty';
  if (value === undefined || value === null) return 'Empty';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const actionLabel = (value: unknown): string => {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'approve' || action === 'approved') return 'Approved';
  if (action === 'reject' || action === 'rejected') return 'Rejected';
  if (action === 'delete' || action === 'deleted') return 'Dismissed';
  if (action === 'dismissed') return 'Dismissed';
  if (action === 'suppressed') return 'Suppressed';
  return action ? action.replaceAll('_', ' ') : 'Review event';
};

export default function SupplierReviewHistoryModal({
  item,
  events,
  loading,
  error,
  nextCursor,
  currentAdmin,
  onLoadMore,
  onClose,
}: SupplierReviewHistoryModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), a[href]')) as HTMLElement[];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  const completedBy = supplierAdministratorLabel(item.decisionCompletedBy, currentAdmin);

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/75 p-2 backdrop-blur-sm sm:p-4" role="presentation">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="supplier-review-history-title" className="max-h-[calc(100dvh-1rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928] sm:max-h-[92vh] sm:rounded-3xl sm:p-6">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white/95 pb-4 backdrop-blur dark:border-slate-800 dark:bg-[#111928]/95">
          <div className="flex min-w-0 items-start gap-3">
            <span className="rounded-xl bg-blue-500/10 p-2 text-blue-600"><History className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0">
              <h3 id="supplier-review-history-title" className="truncate text-base font-black text-slate-900 dark:text-white">{item.productName}</h3>
              <p className="mt-1 text-[11px] text-slate-400">{item.supplierName || 'Supplier'} · {item.supplierCode}</p>
            </div>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close review history" className="rounded-full bg-slate-100 p-2 text-slate-500 dark:bg-slate-800"><X className="h-4 w-4" /></button>
        </header>

        <div className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900/40 sm:grid-cols-3">
          <div><span className="block text-[9px] font-black uppercase tracking-wide text-slate-400">Decision</span><strong>{actionLabel(item.decisionAction)}</strong></div>
          <div><span className="block text-[9px] font-black uppercase tracking-wide text-slate-400">Administrator</span><strong>{completedBy}</strong></div>
          <div><span className="block text-[9px] font-black uppercase tracking-wide text-slate-400">Completed</span><strong>{formatSupplierTimestamp(item.decisionCompletedAt, 'Not recorded')}</strong></div>
        </div>

        <div className="mt-5 space-y-3">
          <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-700 dark:text-slate-200"><Clock3 className="h-4 w-4" aria-hidden="true" />Immutable review timeline</h4>
          {loading && events.length === 0 ? <p role="status" className="rounded-xl border border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">Loading review history…</p> : null}
          {error ? <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs font-semibold text-red-600">{error}</p> : null}
          {!loading && !error && events.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">No audit events were found for this legacy review record.</p> : null}
          <ol className="space-y-3">
            {events.map((event) => {
              const canonicalChanges = Array.isArray(event.supplierFieldChanges) ? event.supplierFieldChanges : [];
              const fallbackChanges = Object.entries(event.changedFields || {}).map(([field, change]) => ({ field, label: field, before: change.before, after: change.after }));
              const changes = canonicalChanges.length > 0 ? canonicalChanges : fallbackChanges;
              return (
                <li key={event.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div><strong className="text-xs text-slate-900 dark:text-white">{actionLabel(event.action)}</strong><p className="mt-1 text-[10px] text-slate-400">{event.previousState || 'Start'} → {event.newState || 'Recorded'}</p></div>
                    <div className="text-right text-[10px] text-slate-400"><span className="block">{formatSupplierTimestamp(event.timestamp, 'Time not recorded')}</span><span>{supplierAdministratorLabel(event.adminEmail || event.adminUserId, currentAdmin)}</span></div>
                  </div>
                  {event.reason ? <p className="mt-3 rounded-xl bg-amber-500/10 p-3 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{event.reason}</p> : null}
                  {changes.length > 0 ? <dl className="mt-3 grid gap-2 sm:grid-cols-2">{changes.map((change) => <div key={`${event.id}-${change.field}`} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/50"><dt className="text-[9px] font-black uppercase tracking-wide text-slate-400">{change.label || change.field}</dt><dd className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><span className="break-words"><b className="block text-slate-400">Before</b>{displayValue(change.before)}</span><span className="break-words"><b className="block text-slate-400">After</b>{displayValue(change.after)}</span></dd></div>)}</dl> : null}
                </li>
              );
            })}
          </ol>
          {nextCursor ? <button type="button" onClick={() => void onLoadMore()} disabled={loading} className="min-h-11 w-full rounded-xl border border-slate-200 px-4 text-xs font-black text-slate-600 disabled:opacity-50 dark:border-slate-800 dark:text-slate-300">{loading ? 'Loading…' : 'Load more history'}</button> : null}
        </div>
      </section>
    </div>
  );
}
