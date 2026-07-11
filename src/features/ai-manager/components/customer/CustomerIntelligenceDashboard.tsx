import { useMemo } from 'react';
import { analyzeCustomers } from '../../services/analyzeCustomers';
import { buildCustomerMetrics } from '../../services/buildCustomerMetrics';
import type { CustomerSnapshot } from '../../types/customer';
import { CustomerInsightPanel } from './CustomerInsightPanel';
import { CustomerLifetimeValueCard } from './CustomerLifetimeValueCard';
import { CustomerOverviewCards } from './CustomerOverviewCards';
import { CustomerRetentionCard } from './CustomerRetentionCard';

interface CustomerIntelligenceDashboardProps { readonly snapshot: CustomerSnapshot }

export function CustomerIntelligenceDashboard({ snapshot }: CustomerIntelligenceDashboardProps) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const analysis = useMemo(() => analyzeCustomers(buildCustomerMetrics(snapshot, now)), [snapshot, dayKey]);
  return <section className="space-y-6 border-t border-slate-800 pt-6" aria-labelledby="customer-intelligence-dashboard-title"><div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-400">Customer Intelligence</p><h2 id="customer-intelligence-dashboard-title" className="mt-1 text-xl font-black text-white">Anonymous customer behaviour</h2><p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">Read-only aggregates from non-cancelled orders. Names, emails, phone numbers, addresses, UIDs, authentication identifiers, and grouping keys are excluded.</p></div><CustomerOverviewCards metrics={analysis.metrics} />{analysis.metrics.hasUsableHistory ? <div className="grid grid-cols-1 gap-4 xl:grid-cols-2"><CustomerRetentionCard retention={analysis.metrics.retention} health={analysis.metrics.health} /><CustomerLifetimeValueCard metrics={analysis.metrics} /></div> : <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-6 text-sm text-slate-500">No usable non-cancelled customer purchase history is available. Customer metrics will appear when identifiable purchase history exists.</p>}<CustomerInsightPanel insights={analysis.insights} /></section>;
}
