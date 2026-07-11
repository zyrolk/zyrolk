import { ChartNoAxesColumnIncreasing } from 'lucide-react';
import type { StockDistribution } from '../../types/inventory';

interface StockDistributionCardProps { readonly distribution: StockDistribution }
const BARS = { healthy: 'bg-emerald-500', low: 'bg-amber-500', out: 'bg-red-500', invalid: 'bg-violet-500' } as const;

export function StockDistributionCard({ distribution }: StockDistributionCardProps) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="stock-distribution-title">
      <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400"><ChartNoAxesColumnIncreasing className="h-5 w-5" aria-hidden="true" /></div><div><h3 id="stock-distribution-title" className="text-base font-black text-white">Stock distribution</h3><p className="text-[11px] text-slate-500">Active products only</p></div></div>
      {distribution.activeProductCount === 0 ? <p className="mt-5 rounded-xl border border-dashed border-slate-700 p-4 text-xs text-slate-500">No active products are available for stock distribution.</p> : (
        <div className="mt-5 space-y-4">{distribution.items.map((item) => <div key={item.key}><div className="flex justify-between gap-3 text-xs"><span className="text-slate-400">{item.label}</span><span className="font-bold text-white">{item.count.toLocaleString()} · {item.percentage.toFixed(1)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className={`h-full rounded-full ${BARS[item.key]}`} style={{ width: `${item.percentage}%` }} /></div></div>)}</div>
      )}
    </article>
  );
}
