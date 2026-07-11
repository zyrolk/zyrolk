import { useMemo } from 'react';
import { analyzeInventory } from '../../services/analyzeInventory';
import { buildInventoryMetrics } from '../../services/buildInventoryMetrics';
import type { InventorySnapshot } from '../../types/inventory';
import { InventoryHealthCard } from './InventoryHealthCard';
import { InventoryInsightPanel } from './InventoryInsightPanel';
import { InventoryOverviewCards } from './InventoryOverviewCards';
import { LowStockProductsCard } from './LowStockProductsCard';
import { StockDistributionCard } from './StockDistributionCard';

interface InventoryIntelligenceDashboardProps { readonly snapshot: InventorySnapshot }

export function InventoryIntelligenceDashboard({ snapshot }: InventoryIntelligenceDashboardProps) {
  const analysis = useMemo(() => analyzeInventory(buildInventoryMetrics(snapshot)), [snapshot]);
  return (
    <section className="space-y-6 border-t border-slate-800 pt-6" aria-labelledby="inventory-intelligence-dashboard-title">
      <div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-400">Inventory Intelligence</p><h2 id="inventory-intelligence-dashboard-title" className="mt-1 text-xl font-black text-white">Observed catalogue health</h2><p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">Read-only calculations from product identifiers, names, stock quantities, and active states. Stock health uses active products only.</p></div>
      {analysis.metrics.hasProducts ? <><InventoryOverviewCards summary={analysis.metrics.summary} /><div className="grid grid-cols-1 gap-4 xl:grid-cols-2"><InventoryHealthCard health={analysis.metrics.health} /><StockDistributionCard distribution={analysis.metrics.stockDistribution} /></div><LowStockProductsCard products={analysis.metrics.lowStockProducts} /></> : <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-6 text-sm text-slate-500">No product data is available. Inventory metrics will appear when catalogue records are present.</p>}
      <InventoryInsightPanel insights={analysis.insights} />
    </section>
  );
}
