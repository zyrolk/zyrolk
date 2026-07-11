import { CircleOff } from 'lucide-react';
import { NOT_CONFIGURED_PROVIDER_STATUS } from '../types/provider';

export function ProviderStatus() {
  return (
    <div className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-900/70 px-3 text-xs font-bold text-slate-300">
      <CircleOff className="h-4 w-4 text-slate-500" aria-hidden="true" />
      <span>Provider: {NOT_CONFIGURED_PROVIDER_STATUS.label}</span>
    </div>
  );
}
