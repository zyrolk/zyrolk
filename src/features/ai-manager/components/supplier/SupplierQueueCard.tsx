import { ListChecks } from 'lucide-react';
import type { SupplierQueueSummary } from '../../types/supplier';

interface SupplierQueueCardProps { readonly queues: SupplierQueueSummary }

export function SupplierQueueCard({ queues }: SupplierQueueCardProps) {
  const values = [{ label: 'Pending reviews', value: queues.pendingReviews }, { label: 'Pending changes', value: queues.pendingChanges }, { label: 'Approval backlog', value: queues.approvalBacklog }];
  return <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="supplier-queue-title"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400"><ListChecks className="h-5 w-5" aria-hidden="true" /></div><div><h3 id="supplier-queue-title" className="text-base font-black text-white">Supplier queues</h3><p className="text-[11px] text-slate-500">Separate factual workflow counts</p></div></div><div className="mt-5 grid grid-cols-3 gap-2">{values.map((item) => <div key={item.label} className="rounded-xl bg-slate-950/50 p-3"><p className="text-xl font-black text-white">{item.value.toLocaleString()}</p><p className="mt-1 text-[9px] font-black uppercase tracking-wider text-slate-500">{item.label}</p></div>)}</div><p className="mt-4 rounded-xl border border-slate-800 px-3.5 py-3 text-xs leading-relaxed text-slate-400">{queues.backlogTrend.message}</p></article>;
}
