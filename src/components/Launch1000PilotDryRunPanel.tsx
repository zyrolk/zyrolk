import React, { useState } from 'react';
import {
  LAUNCH1000_PILOT_MANIFEST_REVISION,
  LAUNCH1000_PILOT_PRODUCT_IDS,
  Launch1000PilotDryRunResponse,
  runLaunch1000PilotDryRun,
} from '../services/launch1000AdminDryRun';

const resultTone = (outcome: string): string => outcome === 'ELIGIBLE'
  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200'
  : outcome === 'STALE_OR_CONFLICT'
    ? 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/20 dark:text-orange-200'
    : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200';

const resultExpectation = (outcome: string): string => outcome === 'ELIGIBLE'
  ? 'Expected Ready for review'
  : 'Expected Needs Attention';

const formatSpecNormalization = (normalization: Record<string, string> | undefined): string => {
  if (!normalization || Object.keys(normalization).length === 0) return 'None';
  return Object.entries(normalization).map(([field, value]) => `${field}: ${value}`).join(' · ');
};

const countFor = (result: Launch1000PilotDryRunResponse | null, outcome: string): number => result?.counts[outcome] || 0;

export default function Launch1000PilotDryRunPanel() {
  const [result, setResult] = useState<Launch1000PilotDryRunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async (): Promise<void> => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await runLaunch1000PilotDryRun());
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : 'The Launch-1000 pilot dry run could not be completed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section
      aria-labelledby="launch1000-pilot-dry-run-title"
      className="rounded-3xl border border-indigo-200/80 bg-indigo-50/50 p-4 shadow-sm dark:border-indigo-900/60 dark:bg-indigo-950/20 sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-700 dark:text-indigo-300">Launch-1000 Pilot Dry Run</p>
          <h3 id="launch1000-pilot-dry-run-title" className="mt-1 text-lg font-black tracking-tight text-slate-900 dark:text-white">Validate the fixed pilot-10</h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-600 dark:text-slate-300">
            Read-only server validation for the approved pilot set. No taxonomy, product, queue, or publication data is changed.
          </p>
          <p className="mt-2 break-all font-mono text-[10px] text-slate-500 dark:text-slate-400">Manifest: {LAUNCH1000_PILOT_MANIFEST_REVISION}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={running}
          className="min-h-11 shrink-0 rounded-xl bg-indigo-600 px-4 text-xs font-black text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? 'Running dry run…' : 'Run Pilot-10 Dry Run'}
        </button>
      </div>

      <p className="mt-3 text-[10px] font-semibold text-slate-500 dark:text-slate-400">Fixed products: {LAUNCH1000_PILOT_PRODUCT_IDS.length}</p>

      {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-200">{error}</p>}

      {result && (
        <div className="mt-5 space-y-3" aria-live="polite">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Eligible', countFor(result, 'ELIGIBLE')],
              ['Blocked', countFor(result, 'NEEDS_ATTENTION')],
              ['Stale/conflict', countFor(result, 'STALE_OR_CONFLICT')],
              ['Other', result.results.length - countFor(result, 'ELIGIBLE') - countFor(result, 'NEEDS_ATTENTION') - countFor(result, 'STALE_OR_CONFLICT')],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
                <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</p>
                <p className="mt-1 text-lg font-black text-slate-900 dark:text-white">{value}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            {result.results.map((item) => (
              <article key={item.productId} className={`rounded-2xl border p-3 ${resultTone(item.outcome)}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-xs font-black">{item.productId}</p>
                    <p className="mt-0.5 text-[10px] font-semibold">SKU: {item.sku || '—'}</p>
                  </div>
                  <span className="rounded-full border border-current px-2 py-1 text-[9px] font-black uppercase">{item.outcome}</span>
                </div>
                <dl className="mt-3 grid gap-x-4 gap-y-2 text-[10px] sm:grid-cols-2">
                  <div><dt className="font-black uppercase tracking-wider opacity-70">Expected state</dt><dd>{resultExpectation(item.outcome)}</dd></div>
                  <div><dt className="font-black uppercase tracking-wider opacity-70">Taxonomy</dt><dd>{item.intendedTaxonomy ? `${item.intendedTaxonomy.categoryId} / ${item.intendedTaxonomy.subcategoryId}` : '—'}</dd></div>
                  <div><dt className="font-black uppercase tracking-wider opacity-70">Spec normalization</dt><dd>{formatSpecNormalization(item.deterministicSpecNormalization)}</dd></div>
                  <div><dt className="font-black uppercase tracking-wider opacity-70">Precondition</dt><dd className="break-all">{item.expectedUpdatedAt || '—'} · {item.expectedFingerprint || '—'}</dd></div>
                  <div className="sm:col-span-2"><dt className="font-black uppercase tracking-wider opacity-70">Reason</dt><dd>{item.reasonCodes.length ? item.reasonCodes.join(', ') : 'No blocker'}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
