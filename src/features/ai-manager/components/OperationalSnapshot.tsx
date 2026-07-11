import { Boxes, CircleDollarSign, ClipboardList, PackageX, TriangleAlert, Users } from 'lucide-react';
import type { AIManagerMetrics } from '../types/snapshot';

interface OperationalSnapshotProps {
  readonly metrics: AIManagerMetrics;
}

const formatCurrency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

export function OperationalSnapshot({ metrics }: OperationalSnapshotProps) {
  const cards = [
    { label: 'Active products', value: metrics.activeProductCount.toLocaleString(), icon: Boxes, tone: 'text-blue-400 bg-blue-500/10' },
    { label: 'Orders observed', value: metrics.orderCount.toLocaleString(), icon: ClipboardList, tone: 'text-indigo-400 bg-indigo-500/10' },
    { label: 'Non-cancelled revenue', value: formatCurrency(metrics.nonCancelledRevenue), icon: CircleDollarSign, tone: 'text-emerald-400 bg-emerald-500/10' },
    { label: 'Customers counted', value: metrics.customerCount.toLocaleString(), icon: Users, tone: 'text-cyan-400 bg-cyan-500/10' },
    { label: 'Low stock', value: metrics.lowStockCount.toLocaleString(), icon: TriangleAlert, tone: 'text-amber-400 bg-amber-500/10' },
    { label: 'Out of stock', value: metrics.outOfStockCount.toLocaleString(), icon: PackageX, tone: 'text-rose-400 bg-rose-500/10' },
  ];

  return (
    <section aria-labelledby="ai-operational-snapshot-title">
      <div className="mb-4">
        <h2 id="ai-operational-snapshot-title" className="text-lg font-black text-white">Operational snapshot</h2>
        <p className="mt-1 text-xs text-slate-500">Deterministic aggregates from data already loaded by the Admin Dashboard.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}>
              <Icon className="h-4.5 w-4.5" aria-hidden="true" />
            </div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</p>
            <p className="mt-1 break-words text-lg font-black text-slate-100">{value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
