import { ScanSearch } from 'lucide-react';
import type { SupplierInsight } from '../../types/supplier';

interface SupplierInsightPanelProps { readonly insights: readonly SupplierInsight[] }
const TONES = { positive: 'border-emerald-500/15 bg-emerald-500/5 text-emerald-300', attention: 'border-amber-500/15 bg-amber-500/5 text-amber-300', neutral: 'border-blue-500/15 bg-blue-500/5 text-blue-300' } as const;

export function SupplierInsightPanel({ insights }: SupplierInsightPanelProps) {
  return <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="supplier-insights-title"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400"><ScanSearch className="h-5 w-5" aria-hidden="true" /></div><div><h3 id="supplier-insights-title" className="text-base font-black text-white">Deterministic supplier insights</h3><p className="text-[11px] text-slate-500">Rule-based supplier facts. No AI provider is used.</p></div></div><div className="mt-5 space-y-2.5">{insights.map((insight) => <p key={insight.code} className={`rounded-xl border px-3.5 py-3 text-xs leading-relaxed ${TONES[insight.severity]}`}>{insight.message}</p>)}</div></section>;
}
