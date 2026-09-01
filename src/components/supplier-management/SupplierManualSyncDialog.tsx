import React, { useMemo, useState } from 'react';
import { RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  buildSupplierManualSyncRequest,
  SupplierManualSyncRequest,
  SupplierSyncCapabilities,
  SupplierSyncFilterExecution,
  SupplierSyncMode,
  supplierSyncFilterExecutionLabel,
  supplierSyncFilterIsSupported,
} from '../../services/supplierManualSync';

interface SupplierManualSyncDialogProps {
  source: {
    id: string;
    name?: string;
    supplierName?: string;
    syncCapabilities?: SupplierSyncCapabilities;
    catalogSync?: {
      status?: string;
      terminationReason?: string | null;
      productsObserved?: number;
      totalProductLimit?: number | null;
      cursor?: string | null;
    };
  };
  /** First-ever sync for this source — require an explicit product count limit. */
  isInitialSync?: boolean;
  busy: boolean;
  onClose(): void;
  onSubmit(request: SupplierManualSyncRequest): Promise<boolean>;
}

function CapabilityLabel({ value }: { value?: SupplierSyncFilterExecution }) {
  if (!supplierSyncFilterIsSupported(value)) return null;
  return (
    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[9px] font-black text-blue-600 dark:text-blue-300">
      {supplierSyncFilterExecutionLabel(value)}
    </span>
  );
}

export default function SupplierManualSyncDialog({
  source,
  isInitialSync = false,
  busy,
  onClose,
  onSubmit,
}: SupplierManualSyncDialogProps) {
  const capabilities = source.syncCapabilities || {};
  const supportsIncremental = capabilities.incremental?.supported === true;
  const [mode, setMode] = useState<SupplierSyncMode>('full');
  const [category, setCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [search, setSearch] = useState('');
  const [totalProductLimit, setTotalProductLimit] = useState(isInitialSync ? '5' : '');
  const [restartFromBeginning, setRestartFromBeginning] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const supplierName = String(source.supplierName || source.name || source.id);
  const limitedCheckpointAvailable = source.catalogSync?.status === 'limited'
    && source.catalogSync?.terminationReason === 'limit_reached'
    && Boolean(source.catalogSync?.cursor);
  const observedCount = Number(source.catalogSync?.productsObserved || 0);
  const batchLimit = Number(source.catalogSync?.totalProductLimit || 0);
  const supportsCategory = supplierSyncFilterIsSupported(capabilities.categoryFilter);
  const supportsSubcategory = supplierSyncFilterIsSupported(capabilities.subcategoryFilter);
  const supportsSearch = supplierSyncFilterIsSupported(capabilities.searchFilter);
  const hasFilters = supportsCategory || supportsSubcategory || supportsSearch;

  const incrementalDescription = useMemo(() => {
    if (!supportsIncremental) return 'This supplier does not provide a trustworthy incremental catalogue feed. Use Full Sync.';
    const mechanism = String(capabilities.incremental?.mechanism || '').replaceAll('_', ' ');
    return mechanism ? `Uses the supplier's ${mechanism} feed.` : 'Uses the supplier-provided change feed.';
  }, [capabilities.incremental?.mechanism, supportsIncremental]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    try {
      if (isInitialSync && !String(totalProductLimit || '').trim()) {
        throw new Error('Set a Product count limit for the first controlled sync (for example 5). Leave blank only after the first trial.');
      }
      const request = buildSupplierManualSyncRequest({
        sourceId: source.id,
        mode,
        category,
        subcategory,
        search,
        totalProductLimit,
        capabilities,
        ...(limitedCheckpointAvailable && !restartFromBeginning ? { catalogContinuation: 'continue' as const } : {}),
        ...(restartFromBeginning ? { catalogContinuation: 'restart' as const } : {}),
      });
      if (await onSubmit(request)) onClose();
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Synchronization options are invalid.');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs" role="dialog" aria-modal="true" aria-labelledby="manual-supplier-sync-title">
      <form onSubmit={submit} className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-800 dark:bg-slate-950 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span className="text-[10px] font-black uppercase tracking-wider">
                {isInitialSync ? 'Initial Sync' : 'Manual Sync'}
              </span>
            </div>
            <h3 id="manual-supplier-sync-title" className="mt-2 text-lg font-black text-slate-900 dark:text-white">
              {isInitialSync ? `First sync for ${supplierName}` : `Update ${supplierName}`}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {isInitialSync
                ? 'Choose a Product count limit for this controlled first sync. Catalog fetch page size is separate and does not stop the run.'
                : limitedCheckpointAvailable
                  ? `Continue from product ${observedCount + 1} using the saved supplier cursor, or restart from the beginning.`
                  : 'Choose which supplier products to check. Every detected change still goes to Product Review.'}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" aria-label="Close manual sync options">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <fieldset className="mt-6 space-y-3">
          <legend className="text-[10px] font-black uppercase tracking-wider text-slate-500">Sync mode</legend>
          <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-4 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-500/5 dark:border-slate-800">
            <input type="radio" name="supplier-sync-mode" value="full" checked={mode === 'full'} onChange={() => setMode('full')} className="mt-0.5 accent-blue-600" />
            <span><strong className="block text-xs text-slate-900 dark:text-white">Full Sync</strong><small className="mt-1 block text-[10px] leading-relaxed text-slate-500">Traverse the supplier catalogue using its durable cursor.</small></span>
          </label>
          {supportsIncremental ? (
            <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-4 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-500/5 dark:border-slate-800">
              <input type="radio" name="supplier-sync-mode" value="incremental" checked={mode === 'incremental'} onChange={() => setMode('incremental')} className="mt-0.5 accent-blue-600" />
              <span><strong className="block text-xs text-slate-900 dark:text-white">Incremental Sync</strong><small className="mt-1 block text-[10px] leading-relaxed text-slate-500">{incrementalDescription}</small></span>
            </label>
          ) : (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[10px] leading-relaxed text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">{incrementalDescription}</p>
          )}
        </fieldset>

        {hasFilters && (
          <section className="mt-6 space-y-4" aria-labelledby="manual-sync-filters-title">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-blue-500" aria-hidden="true" />
              <h4 id="manual-sync-filters-title" className="text-[10px] font-black uppercase tracking-wider text-slate-500">Optional filters</h4>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {supportsCategory && (
                <label className="space-y-1.5">
                  <span className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-600 dark:text-slate-300">Category <CapabilityLabel value={capabilities.categoryFilter} /></span>
                  <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={160} placeholder="Supplier category" className="min-h-11 w-full rounded-xl border border-slate-200 bg-transparent px-3 text-xs dark:border-slate-700" />
                </label>
              )}
              {supportsSubcategory && (
                <label className="space-y-1.5">
                  <span className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-600 dark:text-slate-300">Subcategory <CapabilityLabel value={capabilities.subcategoryFilter} /></span>
                  <input value={subcategory} onChange={(event) => setSubcategory(event.target.value)} maxLength={160} placeholder="Supplier subcategory" className="min-h-11 w-full rounded-xl border border-slate-200 bg-transparent px-3 text-xs dark:border-slate-700" />
                </label>
              )}
              {supportsSearch && (
                <label className="space-y-1.5 sm:col-span-2">
                  <span className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-600 dark:text-slate-300">Search supplier catalogue <CapabilityLabel value={capabilities.searchFilter} /></span>
                  <span className="relative block"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={120} placeholder="Product name, code, barcode or brand" className="min-h-11 w-full rounded-xl border border-slate-200 bg-transparent pl-9 pr-3 text-xs dark:border-slate-700" /></span>
                </label>
              )}
            </div>
          </section>
        )}

        <label className="mt-6 block space-y-1.5">
          <span className="block text-[10px] font-bold text-slate-600 dark:text-slate-300">
            Product count limit
            {isInitialSync
              ? <span className="font-normal text-amber-600"> (required for first sync)</span>
              : <span className="font-normal text-slate-400"> (optional)</span>}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="10000"
            step="1"
            required={isInitialSync}
            value={totalProductLimit}
            onChange={(event) => setTotalProductLimit(event.target.value)}
            placeholder={isInitialSync ? 'e.g. 5' : 'All matching products'}
            className="min-h-11 w-full rounded-xl border border-slate-200 bg-transparent px-3 text-xs dark:border-slate-700"
          />
          <small className="block text-[10px] leading-relaxed text-slate-500">
            Limits how many products this run may scan, normalize, offer, and queue. It is not the catalog fetch page size.
            Limited runs never mark unscanned supplier products as removed.
          </small>
        </label>

        {limitedCheckpointAvailable && mode === 'full' && (
          <fieldset className="mt-6 space-y-3">
            <legend className="text-[10px] font-black uppercase tracking-wider text-slate-500">Limited sync continuation</legend>
            <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-4 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-500/5 dark:border-slate-800">
              <input
                type="radio"
                name="supplier-sync-continuation"
                checked={!restartFromBeginning}
                onChange={() => setRestartFromBeginning(false)}
                className="mt-0.5 accent-blue-600"
              />
              <span>
                <strong className="block text-xs text-slate-900 dark:text-white">Continue next batch</strong>
                <small className="mt-1 block text-[10px] leading-relaxed text-slate-500">
                  Resume after the last {batchLimit > 0 ? batchLimit : 'limited'} products already scanned ({observedCount} observed).
                </small>
              </span>
            </label>
            <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-4 has-[:checked]:border-amber-500 has-[:checked]:bg-amber-500/5 dark:border-slate-800">
              <input
                type="radio"
                name="supplier-sync-continuation"
                checked={restartFromBeginning}
                onChange={() => setRestartFromBeginning(true)}
                className="mt-0.5 accent-amber-600"
              />
              <span>
                <strong className="block text-xs text-slate-900 dark:text-white">Start from beginning</strong>
                <small className="mt-1 block text-[10px] leading-relaxed text-slate-500">
                  Reset the saved supplier cursor and scan from product 1 again.
                </small>
              </span>
            </label>
          </fieldset>
        )}

        {validationError && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">{validationError}</p>}

        <footer className="sticky bottom-0 mt-6 flex flex-col-reverse gap-2 border-t border-slate-200 bg-white pt-4 dark:border-slate-800 dark:bg-slate-950 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-xl bg-slate-100 px-4 text-xs font-black text-slate-700 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200">Cancel</button>
          <button type="submit" disabled={busy} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
            {busy ? 'Starting…' : isInitialSync ? 'Start Initial Sync' : limitedCheckpointAvailable && !restartFromBeginning ? 'Continue Next Batch' : 'Start Sync'}
          </button>
        </footer>
      </form>
    </div>
  );
}
