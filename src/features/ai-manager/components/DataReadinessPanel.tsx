import { Database } from 'lucide-react';
import type { AIDataSetReadiness } from '../types/domain';

interface DataReadinessPanelProps {
  readonly dataSets: readonly AIDataSetReadiness[];
}

export function DataReadinessPanel({ dataSets }: DataReadinessPanelProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="ai-data-readiness-title">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400">
          <Database className="h-4.5 w-4.5" aria-hidden="true" />
        </div>
        <div>
          <h2 id="ai-data-readiness-title" className="text-sm font-black text-white">Data readiness</h2>
          <p className="text-[11px] text-slate-500">Only record counts and aggregate metrics enter this snapshot.</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {dataSets.map((dataSet) => (
          <div key={dataSet.id} className="flex min-h-10 items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 text-[11px]">
            <span className={dataSet.available ? 'text-slate-300' : 'text-slate-500'}>{dataSet.label}</span>
            <span className={`rounded-full px-2 py-0.5 font-mono font-bold ${dataSet.available ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
              {dataSet.recordCount}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
