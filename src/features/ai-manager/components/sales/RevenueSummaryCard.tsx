import { ArrowDownRight, ArrowRight, ArrowUpRight, CircleDollarSign } from 'lucide-react';
import type { RevenueSummary, RevenueTrendPoint, SalesTrendComparison } from '../../types/sales';

interface RevenueSummaryCardProps {
  readonly summary: RevenueSummary;
  readonly trend: readonly RevenueTrendPoint[];
}

const formatCurrency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

function TrendValue({ comparison }: { readonly comparison: SalesTrendComparison }) {
  if (comparison.direction === 'no-baseline') {
    return <span className="text-emerald-400">New activity</span>;
  }
  const percentage = comparison.percentageChange || 0;
  const Icon = comparison.direction === 'up' ? ArrowUpRight : comparison.direction === 'down' ? ArrowDownRight : ArrowRight;
  const color = comparison.direction === 'up' ? 'text-emerald-400' : comparison.direction === 'down' ? 'text-rose-400' : 'text-slate-400';
  return (
    <span className={`inline-flex items-center gap-1 ${color}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {Math.abs(percentage).toFixed(1)}%
    </span>
  );
}

export function RevenueSummaryCard({ summary, trend }: RevenueSummaryCardProps) {
  if (summary.totalOrderCount === 0) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="revenue-summary-title">
        <h2 id="revenue-summary-title" className="text-base font-black text-white">Revenue summary</h2>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">No non-cancelled orders are available for revenue calculations.</p>
      </section>
    );
  }

  const activeDays = trend.filter((point) => point.orderCount > 0);
  const peakDay = activeDays.reduce<RevenueTrendPoint | null>(
    (peak, point) => !peak || point.revenue > peak.revenue ? point : peak,
    null,
  );

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="revenue-summary-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="revenue-summary-title" className="text-base font-black text-white">Revenue summary</h2>
          <p className="mt-1 text-[11px] text-slate-500">All non-cancelled orders currently loaded.</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
          <CircleDollarSign className="h-5 w-5" aria-hidden="true" />
        </div>
      </div>
      <p className="mt-5 text-2xl font-black text-white">{formatCurrency(summary.totalRevenue)}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-xl bg-slate-950/45 p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Average order</p>
          <p className="mt-1 font-black text-slate-200">{formatCurrency(summary.averageOrderValue || 0)}</p>
        </div>
        <div className="rounded-xl bg-slate-950/45 p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Revenue trend</p>
          <p className="mt-1 font-black"><TrendValue comparison={summary.revenueTrend} /></p>
        </div>
        <div className="rounded-xl bg-slate-950/45 p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Order trend</p>
          <p className="mt-1 font-black"><TrendValue comparison={summary.orderTrend} /></p>
        </div>
        <div className="rounded-xl bg-slate-950/45 p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">30-day active days</p>
          <p className="mt-1 font-black text-slate-200">{activeDays.length}</p>
        </div>
      </div>
      {peakDay && (
        <p className="mt-4 text-[11px] text-slate-500">
          Highest daily revenue in the 30-day window: <span className="font-bold text-slate-300">{peakDay.date} · {formatCurrency(peakDay.revenue)}</span>
        </p>
      )}
    </section>
  );
}
