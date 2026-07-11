import { HeartPulse } from 'lucide-react';
import type { InventoryHealth } from '../../types/inventory';

interface InventoryHealthCardProps { readonly health: InventoryHealth }
const TONES = { unavailable: 'text-slate-300 bg-slate-500/10', good: 'text-emerald-300 bg-emerald-500/10', attention: 'text-amber-300 bg-amber-500/10', critical: 'text-red-300 bg-red-500/10' } as const;

export function InventoryHealthCard({ health }: InventoryHealthCardProps) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5" aria-labelledby="inventory-health-title">
      <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-400"><HeartPulse className="h-5 w-5" aria-hidden="true" /></div><h3 id="inventory-health-title" className="text-base font-black text-white">Inventory health</h3></div>
      <p className={`mt-5 inline-flex rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider ${TONES[health.status]}`}>{health.label}</p>
      <p className="mt-3 text-xs leading-relaxed text-slate-400">{health.reasoning}</p>
      {health.status !== 'unavailable' && <p className="mt-4 text-sm font-bold text-white">{health.affectedCount.toLocaleString()} affected · {health.affectedPercentage.toFixed(1)}%</p>}
    </article>
  );
}
