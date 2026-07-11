import { Sparkles } from 'lucide-react';

export function RecommendationsEmptyState() {
  return (
    <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-10 text-center" aria-labelledby="ai-recommendations-title">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800 text-slate-500">
        <Sparkles className="h-5 w-5" aria-hidden="true" />
      </div>
      <h2 id="ai-recommendations-title" className="mt-4 text-base font-black text-white">No recommendations available</h2>
      <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-slate-500">
        Recommendations will become available only after an approved AI provider is configured through a future secure server-side integration.
      </p>
    </section>
  );
}
