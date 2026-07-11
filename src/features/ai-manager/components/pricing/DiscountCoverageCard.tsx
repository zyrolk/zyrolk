import { BadgePercent } from 'lucide-react';
import type { DiscountSummary } from '../../types/pricing';

interface DiscountCoverageCardProps { readonly discounts: DiscountSummary }
const BARS = { none: 'bg-slate-500', 'up-to-10': 'bg-cyan-500', 'up-to-20': 'bg-blue-500', 'up-to-30': 'bg-indigo-500', 'above-30': 'bg-violet-500' } as const;

export function DiscountCoverageCard({ discounts }: DiscountCoverageCardProps) {
  return <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="discount-coverage-title"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400"><BadgePercent className="h-5 w-5" aria-hidden="true" /></div><div><h3 id="discount-coverage-title" className="text-base font-black text-white">Discount coverage</h3><p className="text-[11px] text-slate-500">Derived from selling and original prices</p></div></div><div className="mt-5 flex items-end justify-between gap-3"><div><p className="text-3xl font-black text-white">{discounts.coveragePercentage.toFixed(1)}%</p><p className="mt-1 text-xs text-slate-500">{discounts.discountedProducts} discounted · {discounts.nonDiscountedProducts} not discounted</p></div></div><div className="mt-5 space-y-3">{discounts.distribution.map((item) => <div key={item.key}><div className="flex justify-between gap-3 text-[11px]"><span className="text-slate-400">{item.label}</span><span className="font-bold text-white">{item.count} · {item.percentage.toFixed(1)}%</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className={`h-full rounded-full ${BARS[item.key]}`} style={{ width: `${item.percentage}%` }} /></div></div>)}</div></article>;
}
