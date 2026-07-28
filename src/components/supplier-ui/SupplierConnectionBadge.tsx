import React, { memo } from 'react';
import { supplierConnectionPresentation } from '../../services/supplierHubPresentation';

interface SupplierConnectionBadgeProps {
  source?: Record<string, unknown> | null;
  isSyncing?: boolean;
  compact?: boolean;
}

const TONES = {
  connected: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  syncing: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  paused: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  disabled: 'border-slate-400/20 bg-slate-500/10 text-slate-500 dark:text-slate-400',
  problem: 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400',
} as const;

const DOTS = {
  connected: 'bg-emerald-500',
  syncing: 'bg-blue-500 motion-safe:animate-pulse',
  paused: 'bg-amber-500',
  disabled: 'bg-slate-400',
  problem: 'bg-rose-500',
} as const;

function SupplierConnectionBadge({ source, isSyncing = false, compact = false }: SupplierConnectionBadgeProps) {
  const presentation = supplierConnectionPresentation(source, isSyncing);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-black uppercase tracking-wide ${compact ? 'px-2 py-0.5 text-[8px]' : 'px-2.5 py-1 text-[10px]'} ${TONES[presentation.state]}`}
      aria-label={`Supplier connection: ${presentation.label}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOTS[presentation.state]}`} aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

export default memo(SupplierConnectionBadge);
