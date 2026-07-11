import type { PricingAnalysis, PricingInsight, PricingMetrics } from '../types/pricing';

function deepFreeze<T extends object>(value: T): Readonly<T> { Object.values(value).forEach((child) => { if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object); }); return Object.freeze(value); }
const currency = (value: number) => `LKR ${Math.round(value).toLocaleString()}`;

export function analyzePricing(metrics: PricingMetrics): PricingAnalysis {
  const insights: PricingInsight[] = [];
  if (!metrics.hasActiveProducts) insights.push({ code: 'pricing-no-active-products', severity: 'neutral', message: 'No active product pricing records are available for deterministic analysis.' });
  else {
    insights.push({ code: 'pricing-discount-coverage', severity: metrics.discounts.coveragePercentage >= 20 ? 'positive' : 'attention', message: `${metrics.discounts.coveragePercentage.toFixed(1)}% of active products currently have price-derived discounts.` });
    insights.push({ code: 'pricing-missing-original', severity: 'neutral', message: `${metrics.productsMissingOriginalPrice} active products are missing optional original prices.` });
    insights.push({ code: 'pricing-invalid', severity: metrics.productsWithInvalidPricing > 0 ? 'attention' : 'positive', message: metrics.productsWithInvalidPricing > 0 ? `${metrics.productsWithInvalidPricing} active products have invalid pricing.` : 'No invalid active-product pricing was detected.' });
    const highest = metrics.prices.highestPricedProducts[0];
    const lowest = metrics.prices.lowestPricedProducts[0];
    if (highest) insights.push({ code: 'pricing-highest', severity: 'neutral', message: `${highest.name} is the highest priced active product at ${currency(highest.sellingPrice)}.` });
    if (lowest) insights.push({ code: 'pricing-lowest', severity: 'neutral', message: `${lowest.name} is the lowest priced active product at ${currency(lowest.sellingPrice)}.` });
  }
  return deepFreeze({ metrics, insights }) as PricingAnalysis;
}
