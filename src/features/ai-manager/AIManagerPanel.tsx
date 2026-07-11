import { useAIManagerSnapshot } from './hooks/useAIManagerSnapshot';
import type { AIManagerPanelProps } from './types/view-model';
import { AIManagerGuardrails } from './components/AIManagerGuardrails';
import { AIManagerHeader } from './components/AIManagerHeader';
import { DataReadinessPanel } from './components/DataReadinessPanel';
import { IntelligenceDomainGrid } from './components/IntelligenceDomainGrid';
import { OperationalSnapshot } from './components/OperationalSnapshot';
import { RecommendationsEmptyState } from './components/RecommendationsEmptyState';
import { SalesIntelligenceDashboard } from './components/sales/SalesIntelligenceDashboard';
import { InventoryIntelligenceDashboard } from './components/inventory/InventoryIntelligenceDashboard';

export default function AIManagerPanel({ sourceData, isDarkMode }: AIManagerPanelProps) {
  const snapshot = useAIManagerSnapshot(sourceData);

  return (
    <div className={`space-y-6 rounded-3xl p-1 ${isDarkMode ? 'text-slate-100' : 'text-slate-800'}`}>
      <AIManagerHeader />
      <OperationalSnapshot metrics={snapshot.metrics} />
      <SalesIntelligenceDashboard snapshot={snapshot.sales} />
      <InventoryIntelligenceDashboard snapshot={snapshot.inventory} />
      <IntelligenceDomainGrid intelligence={snapshot.intelligence} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DataReadinessPanel dataSets={snapshot.dataSets} />
        <AIManagerGuardrails />
      </div>
      <RecommendationsEmptyState />
    </div>
  );
}
