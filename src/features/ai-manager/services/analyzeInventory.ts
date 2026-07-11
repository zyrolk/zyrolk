import type { InventoryAnalysis, InventoryInsight, InventoryMetrics } from '../types/inventory';

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object);
  });
  return Object.freeze(value);
}

export function analyzeInventory(metrics: InventoryMetrics): InventoryAnalysis {
  const insights: InventoryInsight[] = [];
  const { summary } = metrics;

  if (!metrics.hasProducts) {
    insights.push({ code: 'inventory-no-products', severity: 'neutral', message: 'No product records are available for deterministic inventory analysis.' });
  } else if (summary.activeProducts === 0) {
    insights.push({ code: 'inventory-no-active-products', severity: 'attention', message: 'No active products are available for stock-health analysis.' });
  } else {
    insights.push({
      code: 'inventory-health',
      severity: metrics.health.status === 'good' ? 'positive' : 'attention',
      message: `Inventory health is ${metrics.health.label.toLowerCase()}. ${metrics.health.reasoning}`,
    });
    insights.push({
      code: 'inventory-low-stock', severity: summary.lowStockProducts > 0 ? 'attention' : 'positive',
      message: summary.lowStockProducts > 0 ? `${summary.lowStockProducts} active products are currently low in stock.` : 'No active low-stock products were detected.',
    });
    insights.push({
      code: 'inventory-out-of-stock', severity: summary.outOfStockProducts > 0 ? 'attention' : 'positive',
      message: summary.outOfStockProducts > 0 ? `${summary.outOfStockProducts} active products are out of stock.` : 'No active out-of-stock products were detected.',
    });
    if (summary.invalidStockProducts > 0) {
      insights.push({ code: 'inventory-invalid-stock', severity: 'attention', message: `${summary.invalidStockProducts} active products have invalid stock values and are excluded from in-stock and out-of-stock totals.` });
    }
  }

  insights.push({
    code: 'inventory-inactive-products', severity: 'neutral',
    message: summary.inactiveProducts > 0 ? `${summary.inactiveProducts} catalogue products are inactive.` : 'No inactive products were detected.',
  });

  return deepFreeze({ metrics, insights }) as InventoryAnalysis;
}
