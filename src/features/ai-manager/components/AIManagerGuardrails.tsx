import { ShieldCheck } from 'lucide-react';
import { AI_MANAGER_ACTION_POLICY } from '../services/aiActionPolicy';

export function AIManagerGuardrails() {
  return (
    <section className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-5" aria-labelledby="ai-guardrails-title">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        <div>
          <h2 id="ai-guardrails-title" className="text-sm font-black text-emerald-300">Permanent safety boundary</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            AI Manager is {AI_MANAGER_ACTION_POLICY.mode}. It cannot publish products, change prices or stock, process orders, approve supplier items, or execute marketing actions.
          </p>
          <p className="mt-2 text-[11px] text-slate-500">Any future action proposal must remain reviewable and require explicit administrator approval.</p>
        </div>
      </div>
    </section>
  );
}
