import { useMemo } from 'react';
import { analyzeSales } from '../../services/analyzeSales';
import { buildSalesMetrics } from '../../services/buildSalesMetrics';
import type { SalesSnapshot } from '../../types/sales';
import { BestSellingProductsCard } from './BestSellingProductsCard';
import { OrderStatusCard } from './OrderStatusCard';
import { RevenueSummaryCard } from './RevenueSummaryCard';
import { SalesInsightPanel } from './SalesInsightPanel';
import { SalesOverviewCards } from './SalesOverviewCards';

interface SalesIntelligenceDashboardProps {
  readonly snapshot: SalesSnapshot;
}

export function SalesIntelligenceDashboard({ snapshot }: SalesIntelligenceDashboardProps) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const analysis = useMemo(
    () => analyzeSales(buildSalesMetrics(snapshot, now)),
    [snapshot, dayKey],
  );

  return (
    <section className="space-y-6 border-t border-slate-800 pt-6" aria-labelledby="sales-intelligence-dashboard-title">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400">Sales Intelligence</p>
        <h2 id="sales-intelligence-dashboard-title" className="mt-1 text-xl font-black text-white">Observed sales performance</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
          Read-only calculations from sanitized order dates, statuses, totals, and product line items. Customer identities are excluded.
        </p>
      </div>
      <SalesOverviewCards
        today={analysis.metrics.today}
        lastSevenDays={analysis.metrics.lastSevenDays}
        lastThirtyDays={analysis.metrics.lastThirtyDays}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RevenueSummaryCard summary={analysis.metrics.revenueSummary} trend={analysis.metrics.revenueTrend} />
        <OrderStatusCard breakdown={analysis.metrics.orderBreakdown} />
      </div>
      <BestSellingProductsCard
        revenueRanking={analysis.metrics.revenueRanking}
        quantityRanking={analysis.metrics.quantityRanking}
      />
      <SalesInsightPanel insights={analysis.insights} />
    </section>
  );
}
