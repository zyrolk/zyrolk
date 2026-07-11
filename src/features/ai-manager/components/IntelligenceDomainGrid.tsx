import type { AIIntelligenceReadiness } from '../types/domain';
import { IntelligenceDomainCard } from './IntelligenceDomainCard';

interface IntelligenceDomainGridProps {
  readonly intelligence: readonly AIIntelligenceReadiness[];
}

export function IntelligenceDomainGrid({ intelligence }: IntelligenceDomainGridProps) {
  return (
    <section aria-labelledby="ai-domain-readiness-title">
      <div className="mb-4">
        <h2 id="ai-domain-readiness-title" className="text-lg font-black text-white">Intelligence readiness</h2>
        <p className="mt-1 text-xs text-slate-500">Readiness reflects real dataset coverage, not generated insights.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {intelligence.map((readiness) => (
          <div key={readiness.domain}>
            <IntelligenceDomainCard readiness={readiness} />
          </div>
        ))}
      </div>
    </section>
  );
}
