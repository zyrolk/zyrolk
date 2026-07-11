import { CalendarDays, CalendarRange, Clock3 } from 'lucide-react';
import type { SalesPeriodMetrics } from '../../types/sales';

interface SalesOverviewCardsProps {
  readonly today: SalesPeriodMetrics;
  readonly lastSevenDays: SalesPeriodMetrics;
  readonly lastThirtyDays: SalesPeriodMetrics;
}

const formatCurrency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

export function SalesOverviewCards({ today, lastSevenDays, lastThirtyDays }: SalesOverviewCardsProps) {
  const cards = [
    { period: today, icon: Clock3, tone: 'bg-blue-500/10 text-blue-400' },
    { period: lastSevenDays, icon: CalendarDays, tone: 'bg-indigo-500/10 text-indigo-400' },
    { period: lastThirtyDays, icon: CalendarRange, tone: 'bg-cyan-500/10 text-cyan-400' },
  ];

  return (
    <section aria-labelledby="sales-overview-title">
      <div className="mb-4">
        <h2 id="sales-overview-title" className="text-lg font-black text-white">Sales overview</h2>
        <p className="mt-1 text-xs text-slate-500">Non-cancelled order activity across fixed calendar periods.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {cards.map(({ period, icon: Icon, tone }) => (
          <article key={period.label} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${tone}`}>
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="mt-4 text-xs font-black uppercase tracking-wider text-slate-400">{period.label}</h3>
            {period.hasSales ? (
              <>
                <p className="mt-2 text-2xl font-black text-white">{formatCurrency(period.revenue)}</p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                  <span>{period.orderCount} {period.orderCount === 1 ? 'order' : 'orders'}</span>
                  <span>Average {formatCurrency(period.averageOrderValue || 0)}</span>
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-xl border border-dashed border-slate-700 px-3 py-4 text-xs text-slate-500">
                No non-cancelled sales were recorded in this period.
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
