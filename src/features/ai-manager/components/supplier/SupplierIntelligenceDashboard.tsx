import { useMemo } from 'react';
import { analyzeSuppliers } from '../../services/analyzeSuppliers';
import { buildSupplierMetrics } from '../../services/buildSupplierMetrics';
import type { SupplierSnapshot } from '../../types/supplier';
import { SupplierHealthCard } from './SupplierHealthCard';
import { SupplierInsightPanel } from './SupplierInsightPanel';
import { SupplierOverviewCards } from './SupplierOverviewCards';
import { SupplierQueueCard } from './SupplierQueueCard';
import { SupplierSyncCard } from './SupplierSyncCard';

interface SupplierIntelligenceDashboardProps { readonly snapshot: SupplierSnapshot }

export function SupplierIntelligenceDashboard({ snapshot }: SupplierIntelligenceDashboardProps) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const analysis = useMemo(() => analyzeSuppliers(buildSupplierMetrics(snapshot, now)), [snapshot, dayKey]);
  return <section className="space-y-6 border-t border-slate-800 pt-6" aria-labelledby="supplier-intelligence-dashboard-title"><div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-400">Supplier Intelligence</p><h2 id="supplier-intelligence-dashboard-title" className="mt-1 text-xl font-black text-white">Observed supplier operations</h2><p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">Read-only calculations from sanitized supplier states, sync outcomes, and queue statuses. URLs, credentials, payloads, and connector configuration are excluded.</p></div>{analysis.metrics.hasSuppliers ? <><SupplierOverviewCards metrics={analysis.metrics} /><div className="grid grid-cols-1 gap-4 xl:grid-cols-2"><SupplierSyncCard sync={analysis.metrics.sync} /><SupplierQueueCard queues={analysis.metrics.queues} /></div><SupplierHealthCard healthy={analysis.metrics.topHealthySuppliers} attention={analysis.metrics.attentionSuppliers} /></> : <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-6 text-sm text-slate-500">No supplier data is available. Supplier intelligence will appear when supplier records are present.</p>}<SupplierInsightPanel insights={analysis.insights} /></section>;
}
