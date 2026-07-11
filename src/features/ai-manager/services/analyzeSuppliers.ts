import type { SupplierAnalysis, SupplierInsight, SupplierMetrics } from '../types/supplier';

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object);
  });
  return Object.freeze(value);
}

export function analyzeSuppliers(metrics: SupplierMetrics): SupplierAnalysis {
  const insights: SupplierInsight[] = [];
  if (!metrics.hasSuppliers) {
    insights.push({ code: 'supplier-no-sources', severity: 'neutral', message: 'No supplier records are available for deterministic supplier analysis.' });
  } else if (metrics.enabledSuppliers === 0) {
    insights.push({ code: 'supplier-no-enabled-sources', severity: 'attention', message: 'No suppliers are currently enabled for health analysis.' });
  } else {
    if (metrics.sync.failedSyncs === 0 && metrics.sync.totalSyncs > 0) {
      insights.push({ code: 'supplier-no-failures', severity: 'positive', message: 'No supplier synchronization failures were detected in valid sync history.' });
    } else if (metrics.sync.failedSyncs > 0) {
      insights.push({ code: 'supplier-failures', severity: 'attention', message: `${metrics.sync.failedSyncs} failed supplier ${metrics.sync.failedSyncs === 1 ? 'sync was' : 'syncs were'} detected.` });
    }
    const rated = metrics.supplierHealth.filter((item) => item.successRate !== null);
    if (rated.length > 0) {
      const highestRate = Math.max(...rated.map((item) => item.successRate || 0));
      const leaders = rated.filter((item) => item.successRate === highestRate).map((item) => item.supplierName);
      insights.push({ code: 'supplier-highest-success-rate', severity: 'neutral', message: `${leaders.join(', ')} ${leaders.length === 1 ? 'has' : 'share'} the highest observed successful sync rate at ${highestRate.toFixed(1)}%.` });
    }
  }
  insights.push({
    code: 'supplier-approval-backlog', severity: metrics.queues.approvalBacklog > 0 ? 'attention' : 'positive',
    message: metrics.queues.approvalBacklog > 0 ? `${metrics.queues.approvalBacklog} supplier approvals are waiting in the review queue.` : 'No supplier approvals are waiting in the review queue.',
  });
  insights.push({ code: 'supplier-backlog-trend', severity: metrics.queues.backlogTrend.direction === 'increased' ? 'attention' : 'neutral', message: metrics.queues.backlogTrend.message });
  return deepFreeze({ metrics, insights }) as SupplierAnalysis;
}
