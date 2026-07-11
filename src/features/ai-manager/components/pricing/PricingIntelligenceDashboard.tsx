import { useMemo } from 'react';
import { analyzePricing } from '../../services/analyzePricing';
import { buildPricingMetrics } from '../../services/buildPricingMetrics';
import type { PricingSnapshot } from '../../types/pricing';
import { DiscountCoverageCard } from './DiscountCoverageCard';
import { PriceDistributionCard } from './PriceDistributionCard';
import { PricingHealthCard } from './PricingHealthCard';
import { PricingInsightPanel } from './PricingInsightPanel';
import { PricingOverviewCards } from './PricingOverviewCards';

interface PricingIntelligenceDashboardProps { readonly snapshot: PricingSnapshot }

export function PricingIntelligenceDashboard({ snapshot }: PricingIntelligenceDashboardProps) {
  const analysis = useMemo(() => analyzePricing(buildPricingMetrics(snapshot)), [snapshot]);
  return (
    <section className="space-y-6 border-t border-slate-800 pt-6" aria-labelledby="pricing-intelligence-dashboard-title">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-400">Pricing Intelligence</p>
        <h2 id="pricing-intelligence-dashboard-title" className="mt-1 text-xl font-black text-white">Observed catalogue pricing</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">Read-only active-product analysis. Discounts are derived from selling and original prices; stored discounts are used only for consistency validation.</p>
      </div>
      <PricingOverviewCards metrics={analysis.metrics} />
      {analysis.metrics.hasActiveProducts ? (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <PricingHealthCard health={analysis.metrics.health} invalid={analysis.metrics.invalidPricing} consistency={analysis.metrics.consistencyIssues} products={analysis.metrics.productIssues} />
            <DiscountCoverageCard discounts={analysis.metrics.discounts} />
          </div>
          <PriceDistributionCard prices={analysis.metrics.prices} />
        </>
      ) : (
        <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-6 text-sm text-slate-500">No active product pricing is available. Pricing metrics will appear when active catalogue records are present.</p>
      )}
      <PricingInsightPanel insights={analysis.insights} />
    </section>
  );
}
