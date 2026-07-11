import type { SalesAnalysis, SalesInsight, SalesMetrics } from '../types/sales';

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child as object);
    }
  });
  return Object.freeze(value);
}

const formatCurrency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;
const formatPercentage = (value: number) => `${Math.abs(value).toFixed(1)}%`;

export function analyzeSales(metrics: SalesMetrics): SalesAnalysis {
  const insights: SalesInsight[] = [];

  if (!metrics.hasOrders) {
    insights.push({
      code: 'sales-no-orders',
      severity: 'neutral',
      message: 'No order records are available for deterministic sales analysis.',
    });
  } else if (!metrics.lastSevenDays.hasSales) {
    insights.push({
      code: 'sales-no-current-period-orders',
      severity: 'attention',
      message: 'No non-cancelled orders were recorded in the last 7 days.',
    });
  }

  const revenueTrend = metrics.revenueSummary.revenueTrend;
  if (revenueTrend.direction === 'up' && revenueTrend.percentageChange !== null) {
    insights.push({
      code: 'sales-revenue-increased',
      severity: 'positive',
      message: `Revenue increased ${formatPercentage(revenueTrend.percentageChange)} compared with the previous 7-day period.`,
    });
  } else if (revenueTrend.direction === 'down' && revenueTrend.percentageChange !== null) {
    insights.push({
      code: 'sales-revenue-decreased',
      severity: 'attention',
      message: `Revenue decreased ${formatPercentage(revenueTrend.percentageChange)} compared with the previous 7-day period.`,
    });
  } else if (revenueTrend.direction === 'flat' && metrics.lastSevenDays.hasSales) {
    insights.push({
      code: 'sales-revenue-unchanged',
      severity: 'neutral',
      message: 'Revenue was unchanged compared with the previous 7-day period.',
    });
  } else if (revenueTrend.direction === 'no-baseline') {
    insights.push({
      code: 'sales-revenue-new-baseline',
      severity: 'positive',
      message: `${formatCurrency(revenueTrend.currentValue)} was recorded in the last 7 days; the previous period had no non-cancelled revenue.`,
    });
  }

  const orderTrend = metrics.revenueSummary.orderTrend;
  if (orderTrend.direction === 'up' && orderTrend.percentageChange !== null) {
    insights.push({
      code: 'sales-orders-increased',
      severity: 'positive',
      message: `Order volume increased ${formatPercentage(orderTrend.percentageChange)} compared with the previous 7-day period.`,
    });
  } else if (orderTrend.direction === 'down' && orderTrend.percentageChange !== null) {
    insights.push({
      code: 'sales-orders-decreased',
      severity: 'attention',
      message: `Order volume decreased ${formatPercentage(orderTrend.percentageChange)} compared with the previous 7-day period.`,
    });
  }

  const revenueLeader = metrics.revenueRanking.highest[0];
  if (revenueLeader) {
    insights.push({
      code: 'sales-top-revenue-product',
      severity: 'neutral',
      message: `${revenueLeader.productName} generated the highest observed product revenue at ${formatCurrency(revenueLeader.revenue)}.`,
    });
  }

  const quantityLeader = metrics.quantityRanking.highest[0];
  if (quantityLeader) {
    insights.push({
      code: 'sales-top-quantity-product',
      severity: 'neutral',
      message: `${quantityLeader.productName} sold the highest observed quantity at ${quantityLeader.quantity.toLocaleString()} units.`,
    });
  }

  return deepFreeze({ metrics, insights }) as SalesAnalysis;
}
