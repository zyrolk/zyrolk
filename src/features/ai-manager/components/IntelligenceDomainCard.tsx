import {
  BadgeDollarSign,
  Boxes,
  Megaphone,
  PackageSearch,
  ShoppingCart,
  UsersRound,
} from 'lucide-react';
import type { AIIntelligenceDomain, AIIntelligenceReadiness } from '../types/domain';

interface IntelligenceDomainCardProps {
  readonly readiness: AIIntelligenceReadiness;
}

const ICONS = {
  sales: ShoppingCart,
  inventory: Boxes,
  supplier: PackageSearch,
  pricing: BadgeDollarSign,
  customer: UsersRound,
  marketing: Megaphone,
} satisfies Record<AIIntelligenceDomain, typeof ShoppingCart>;

const STATUS_STYLES = {
  ready: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  limited: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
  unavailable: 'border-slate-700 bg-slate-800/70 text-slate-400',
} as const;

export function IntelligenceDomainCard({ readiness }: IntelligenceDomainCardProps) {
  const Icon = ICONS[readiness.domain];

  return (
    <article className="flex h-full flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider ${STATUS_STYLES[readiness.status]}`}>
          {readiness.status}
        </span>
      </div>
      <h3 className="mt-4 text-base font-black text-white">{readiness.label}</h3>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">{readiness.description}</p>
      <div className="mt-5 border-t border-slate-800 pt-4">
        <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Available datasets</p>
        {readiness.availableDataSets.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {readiness.availableDataSets.map((dataSet) => (
              <li key={dataSet.id} className="flex items-center justify-between gap-3 text-[11px] text-slate-300">
                <span>{dataSet.label}</span>
                <span className="font-mono text-slate-500">{dataSet.recordCount}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11px] text-slate-500">No supporting records are currently loaded.</p>
        )}
      </div>
    </article>
  );
}
