import { CircleOff, HeartPulse, Network, Power, TriangleAlert } from 'lucide-react';
import type { SupplierMetrics } from '../../types/supplier';

interface SupplierOverviewCardsProps { readonly metrics: SupplierMetrics }

export function SupplierOverviewCards({ metrics }: SupplierOverviewCardsProps) {
  const cards = [
    { label: 'Total suppliers', value: metrics.totalSuppliers, icon: Network, tone: 'bg-blue-500/10 text-blue-400' },
    { label: 'Enabled', value: metrics.enabledSuppliers, icon: Power, tone: 'bg-emerald-500/10 text-emerald-400' },
    { label: 'Disabled', value: metrics.disabledSuppliers, icon: CircleOff, tone: 'bg-slate-500/10 text-slate-400' },
    { label: 'Healthy', value: metrics.healthySuppliers, icon: HeartPulse, tone: 'bg-cyan-500/10 text-cyan-400' },
    { label: 'Require attention', value: metrics.suppliersRequiringAttention, icon: TriangleAlert, tone: 'bg-amber-500/10 text-amber-400' },
  ];
  return <section aria-labelledby="supplier-overview-title"><h3 id="supplier-overview-title" className="text-lg font-black text-white">Supplier overview</h3><p className="mt-1 text-xs text-slate-500">Health counts include enabled suppliers only; disabled suppliers are reported separately.</p><div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">{cards.map(({ label, value, icon: Icon, tone }) => <article key={label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}><Icon className="h-4 w-4" aria-hidden="true" /></div><p className="mt-3 text-2xl font-black text-white">{value.toLocaleString()}</p><p className="mt-1 text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</p></article>)}</div></section>;
}
