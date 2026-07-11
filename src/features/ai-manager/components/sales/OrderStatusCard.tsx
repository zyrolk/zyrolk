import { ListChecks } from 'lucide-react';
import type { OrderBreakdown } from '../../types/sales';

interface OrderStatusCardProps {
  readonly breakdown: OrderBreakdown;
}

const formatCurrency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

export function OrderStatusCard({ breakdown }: OrderStatusCardProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="order-status-breakdown-title">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
          <ListChecks className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 id="order-status-breakdown-title" className="text-base font-black text-white">Order status breakdown</h2>
          <p className="text-[11px] text-slate-500">All loaded orders, including cancelled records.</p>
        </div>
      </div>
      {breakdown.totalOrders === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-slate-500">No order records are available for a status breakdown.</p>
      ) : (
        <div className="mt-5 space-y-2">
          {breakdown.statuses.map((status) => (
            <div key={status.status} className="rounded-xl bg-slate-950/45 px-3 py-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-bold capitalize text-slate-300">{status.status}</span>
                <span className="font-mono text-[10px] text-slate-500">{status.orderCount} · {status.percentageOfOrders.toFixed(1)}%</span>
              </div>
              <p className="mt-1 text-[10px] text-slate-600">Recorded value: {formatCurrency(status.revenue)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
