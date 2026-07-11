import { BadgeDollarSign, CircleOff, FileQuestion, ShieldAlert } from 'lucide-react';
import type { PricingMetrics } from '../../types/pricing';

interface PricingOverviewCardsProps { readonly metrics: PricingMetrics }

export function PricingOverviewCards({ metrics }: PricingOverviewCardsProps) {
  const cards = [
    { label: 'With sale prices', value: metrics.productsWithSalePrices, icon: BadgeDollarSign, tone: 'bg-emerald-500/10 text-emerald-400' },
    { label: 'Without sale prices', value: metrics.productsWithoutSalePrices, icon: CircleOff, tone: 'bg-amber-500/10 text-amber-400' },
    { label: 'Missing original price', value: metrics.productsMissingOriginalPrice, icon: FileQuestion, tone: 'bg-blue-500/10 text-blue-400' },
    { label: 'Invalid pricing', value: metrics.productsWithInvalidPricing, icon: ShieldAlert, tone: 'bg-red-500/10 text-red-400' },
  ];
  return <section aria-labelledby="pricing-overview-title"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="pricing-overview-title" className="text-lg font-black text-white">Pricing overview</h3><p className="mt-1 text-xs text-slate-500">Active products only</p></div><p className="text-[11px] text-slate-500">Catalogue: {metrics.catalogue.totalProducts} total · {metrics.catalogue.activeProducts} active · {metrics.catalogue.inactiveProducts} inactive</p></div><div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{cards.map(({ label, value, icon: Icon, tone }) => <article key={label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}><Icon className="h-4 w-4" aria-hidden="true" /></div><p className="mt-3 text-2xl font-black text-white">{value.toLocaleString()}</p><p className="mt-1 text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</p></article>)}</div></section>;
}
