import type { CustomerAnalysis, CustomerInsight, CustomerMetrics } from '../types/customer';

function deepFreeze<T extends object>(value: T): Readonly<T> { Object.values(value).forEach((child) => { if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object); }); return Object.freeze(value); }
const currency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

export function analyzeCustomers(metrics: CustomerMetrics): CustomerAnalysis {
  const insights: CustomerInsight[] = [];
  if (!metrics.hasUsableHistory) {
    insights.push({ code: 'customer-no-history', severity: 'attention', message: 'No usable non-cancelled customer purchase history is available.' });
  } else {
    insights.push({
      code: 'customer-repeat-share', severity: metrics.returningCustomers > 0 ? 'neutral' : 'attention',
      message: metrics.returningCustomers > 0
        ? `${metrics.returningCustomers} of ${metrics.activePurchasingCustomers} active purchasing customers are returning customers (${metrics.repeatPurchaseRate.toFixed(1)}%).`
        : `No repeat customers were detected among ${metrics.activePurchasingCustomers} active purchasing customers.`,
    });
    if (metrics.averageOrdersPerCustomer !== null) insights.push({ code: 'customer-average-orders', severity: 'neutral', message: `Average customer places ${metrics.averageOrdersPerCustomer.toFixed(2)} non-cancelled orders.` });
    if (metrics.averageCustomerLifetimeValue !== null) insights.push({ code: 'customer-average-ltv', severity: 'neutral', message: `Average customer lifetime value from non-cancelled orders is ${currency(metrics.averageCustomerLifetimeValue)}.` });
    const trend = metrics.retention;
    if (trend.trend === 'improving' || trend.trend === 'declining') insights.push({ code: `customer-retention-${trend.trend}`, severity: trend.trend === 'improving' ? 'positive' : 'attention', message: `Customer retention is ${trend.trend} by ${Math.abs(trend.percentagePointChange || 0).toFixed(1)} percentage points compared with the previous 30-day period.` });
    else if (trend.trend === 'unchanged') insights.push({ code: 'customer-retention-unchanged', severity: 'neutral', message: 'Customer retention is unchanged compared with the previous 30-day period.' });
    else insights.push({ code: 'customer-retention-unavailable', severity: 'neutral', message: 'Customer retention trend is unavailable because both 30-day periods do not contain active purchasers.' });
  }
  return deepFreeze({ metrics, insights }) as CustomerAnalysis;
}
