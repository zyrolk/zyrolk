import { ContactRound, UserCheck, UserPlus, UserRoundCheck, UsersRound } from 'lucide-react';
import type { CustomerMetrics } from '../../types/customer';

interface CustomerOverviewCardsProps { readonly metrics: CustomerMetrics }

export function CustomerOverviewCards({ metrics }: CustomerOverviewCardsProps) {
  const cards = [
    { label: 'Total customers', value: metrics.totalCustomers, detail: 'Admin customer records', icon: ContactRound, tone: 'bg-blue-500/10 text-blue-400' },
    { label: 'New customers', value: metrics.newCustomers, detail: 'First purchase in current 30 days', icon: UserPlus, tone: 'bg-cyan-500/10 text-cyan-400' },
    { label: 'Returning customers', value: metrics.returningCustomers, detail: `${metrics.repeatPurchaseRate.toFixed(1)}% of active purchasers`, icon: UsersRound, tone: 'bg-emerald-500/10 text-emerald-400' },
    { label: 'Multiple purchases', value: metrics.customersWithMultiplePurchases, detail: 'At least 2 non-cancelled orders', icon: UserRoundCheck, tone: 'bg-violet-500/10 text-violet-400' },
    { label: 'Single purchase', value: metrics.customersWithSinglePurchase, detail: 'Exactly 1 non-cancelled order', icon: UserCheck, tone: 'bg-amber-500/10 text-amber-400' },
  ];
  return <section aria-labelledby="customer-overview-title"><div><h3 id="customer-overview-title" className="text-lg font-black text-white">Customer overview</h3><p className="mt-1 text-xs text-slate-500">Repeat and lifetime metrics use non-cancelled orders only.</p></div><div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">{cards.map(({ label, value, detail, icon: Icon, tone }) => <article key={label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}><Icon className="h-4 w-4" aria-hidden="true" /></div><p className="mt-3 text-2xl font-black text-white">{value.toLocaleString()}</p><p className="mt-1 text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 text-[10px] leading-relaxed text-slate-600">{detail}</p></article>)}</div></section>;
}
