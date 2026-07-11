import { Archive, CircleOff, PackageCheck, PackageOpen, TriangleAlert } from 'lucide-react';
import type { InventorySummary } from '../../types/inventory';

interface InventoryOverviewCardsProps { readonly summary: InventorySummary }

export function InventoryOverviewCards({ summary }: InventoryOverviewCardsProps) {
  const cards = [
    { label: 'Total products', value: summary.totalProducts, icon: Archive, tone: 'bg-blue-500/10 text-blue-400' },
    { label: 'Active products', value: summary.activeProducts, icon: PackageCheck, tone: 'bg-emerald-500/10 text-emerald-400' },
    { label: 'Inactive products', value: summary.inactiveProducts, icon: CircleOff, tone: 'bg-slate-500/10 text-slate-400' },
    { label: 'In stock', value: summary.inStockProducts, icon: PackageOpen, tone: 'bg-cyan-500/10 text-cyan-400' },
    { label: 'Out of stock', value: summary.outOfStockProducts, icon: CircleOff, tone: 'bg-red-500/10 text-red-400' },
    { label: 'Low stock', value: summary.lowStockProducts, icon: TriangleAlert, tone: 'bg-amber-500/10 text-amber-400' },
  ];
  return (
    <section aria-labelledby="inventory-overview-title">
      <h3 id="inventory-overview-title" className="text-lg font-black text-white">Catalogue overview</h3>
      <p className="mt-1 text-xs text-slate-500">Catalogue totals and active-product stock availability.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <article key={label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}><Icon className="h-4 w-4" aria-hidden="true" /></div>
            <p className="mt-3 text-2xl font-black text-white">{value.toLocaleString()}</p>
            <p className="mt-1 text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
