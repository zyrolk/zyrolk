import type {
  DiscountDistributionItem,
  PricingHealth,
  PricingIssueCategory,
  PricingIssueSummary,
  PricingMetrics,
  PricingSnapshot,
  PricingSnapshotProduct,
} from '../types/pricing';

type MutableDiscountBucket = { -readonly [Key in keyof DiscountDistributionItem]: DiscountDistributionItem[Key] };

export const HEALTHY_DISCOUNT_COVERAGE_THRESHOLD = 20 as const;

const ISSUE_LABELS: Readonly<Record<PricingIssueCategory, string>> = Object.freeze({
  'missing-selling-price': 'Missing selling price',
  'non-finite-selling-price': 'Non-finite selling price',
  'negative-selling-price': 'Negative selling price',
  'non-finite-original-price': 'Non-finite original price',
  'non-positive-original-price': 'Non-positive original price',
  'selling-above-original': 'Selling price above original price',
  'invalid-stored-discount': 'Invalid stored discount',
  'stored-discount-mismatch': 'Stored discount does not match derived discount',
});

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object);
  });
  return Object.freeze(value);
}

function percentage(count: number, total: number): number { return total > 0 ? (count / total) * 100 : 0; }
function isValidSellingPrice(value: number | null): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function isValidOriginalPrice(value: number | null): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function derivedDiscount(product: PricingSnapshotProduct): number | null {
  if (!isValidSellingPrice(product.sellingPrice) || !isValidOriginalPrice(product.originalPrice) || product.originalPrice <= product.sellingPrice) return null;
  return ((product.originalPrice - product.sellingPrice) / product.originalPrice) * 100;
}

function productIssues(product: PricingSnapshotProduct): readonly PricingIssueCategory[] {
  const issues: PricingIssueCategory[] = [];
  const selling = product.sellingPrice;
  const original = product.originalPrice;
  const stored = product.storedDiscount;
  if (selling === null || selling === 0) issues.push('missing-selling-price');
  else if (!Number.isFinite(selling)) issues.push('non-finite-selling-price');
  else if (selling < 0) issues.push('negative-selling-price');
  if (original !== null) {
    if (!Number.isFinite(original)) issues.push('non-finite-original-price');
    else if (original <= 0) issues.push('non-positive-original-price');
    else if (isValidSellingPrice(selling) && selling > original) issues.push('selling-above-original');
  }
  if (stored !== null && (!Number.isFinite(stored) || stored < 0 || stored > 100)) {
    issues.push('invalid-stored-discount');
  } else if (stored !== null && stored > 0) {
    const derived = derivedDiscount(product);
    if (derived === null || Math.abs(stored - Math.round(derived)) > 0.5) issues.push('stored-discount-mismatch');
  }
  return issues;
}

function summarize(categories: readonly PricingIssueCategory[], selected: readonly PricingIssueCategory[]): readonly PricingIssueSummary[] {
  return selected.map((category) => ({ category, label: ISSUE_LABELS[category], count: categories.filter((item) => item === category).length }));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function buildHealth(activeCount: number, criticalCount: number, missingCount: number, consistencyCount: number, coverage: number): PricingHealth {
  if (activeCount === 0) return { status: 'unavailable', label: 'Unavailable', reasons: ['No active product pricing records are available.'], healthyDiscountThreshold: HEALTHY_DISCOUNT_COVERAGE_THRESHOLD };
  if (criticalCount > 0) return { status: 'critical', label: 'Critical', reasons: [`${criticalCount} active products contain negative, non-finite, non-positive original, or selling-above-original pricing.`], healthyDiscountThreshold: HEALTHY_DISCOUNT_COVERAGE_THRESHOLD };
  const reasons: string[] = [];
  if (missingCount > 0) reasons.push(`${missingCount} active products are missing a required selling price.`);
  if (consistencyCount > 0) reasons.push(`${consistencyCount} stored discount consistency issues were detected.`);
  if (coverage < HEALTHY_DISCOUNT_COVERAGE_THRESHOLD) reasons.push(`Discount coverage is ${coverage.toFixed(1)}%, below the documented 20% healthy threshold.`);
  return reasons.length > 0
    ? { status: 'attention', label: 'Needs attention', reasons, healthyDiscountThreshold: HEALTHY_DISCOUNT_COVERAGE_THRESHOLD }
    : { status: 'healthy', label: 'Healthy', reasons: [`No invalid or inconsistent prices were detected and discount coverage meets the documented 20% threshold.`], healthyDiscountThreshold: HEALTHY_DISCOUNT_COVERAGE_THRESHOLD };
}

export function buildPricingMetrics(snapshot: PricingSnapshot): PricingMetrics {
  const products = [...snapshot.products];
  const active = products.filter((product) => product.isActive);
  const issueMap = active.map((product) => ({ product, issues: productIssues(product) }));
  const allIssues = issueMap.flatMap((item) => item.issues);
  const criticalCategories: readonly PricingIssueCategory[] = ['non-finite-selling-price', 'negative-selling-price', 'non-finite-original-price', 'non-positive-original-price', 'selling-above-original'];
  const consistencyCategories: readonly PricingIssueCategory[] = ['invalid-stored-discount', 'stored-discount-mismatch'];
  const criticalProducts = issueMap.filter((item) => item.issues.some((issue) => criticalCategories.includes(issue)));
  const missingProducts = issueMap.filter((item) => item.issues.includes('missing-selling-price'));
  const consistencyProducts = issueMap.filter((item) => item.issues.some((issue) => consistencyCategories.includes(issue)));
  const validPriced = active.filter((product) => isValidSellingPrice(product.sellingPrice));
  const discounts = active.map((product) => derivedDiscount(product));
  const discountCount = discounts.filter((value): value is number => value !== null).length;
  const coverage = percentage(discountCount, active.length);
  const buckets: MutableDiscountBucket[] = [
    { key: 'none', label: 'No discount', count: 0, percentage: 0 },
    { key: 'up-to-10', label: '1–10%', count: 0, percentage: 0 },
    { key: 'up-to-20', label: 'Above 10–20%', count: 0, percentage: 0 },
    { key: 'up-to-30', label: 'Above 20–30%', count: 0, percentage: 0 },
    { key: 'above-30', label: 'Above 30%', count: 0, percentage: 0 },
  ];
  discounts.forEach((value) => {
    const key = value === null ? 'none' : value <= 10 ? 'up-to-10' : value <= 20 ? 'up-to-20' : value <= 30 ? 'up-to-30' : 'above-30';
    const bucket = buckets.find((item) => item.key === key);
    if (bucket) bucket.count += 1;
  });
  buckets.forEach((bucket) => { bucket.percentage = percentage(bucket.count, active.length); });
  const ranked = validPriced.map((product) => ({ id: product.id, name: product.name, sellingPrice: product.sellingPrice as number }));
  const high = [...ranked].sort((a, b) => b.sellingPrice - a.sellingPrice || a.name.localeCompare(b.name));
  const low = [...ranked].sort((a, b) => a.sellingPrice - b.sellingPrice || a.name.localeCompare(b.name));
  const values = ranked.map((product) => product.sellingPrice);

  const metrics: PricingMetrics = {
    hasActiveProducts: active.length > 0,
    catalogue: { totalProducts: products.length, activeProducts: active.length, inactiveProducts: products.length - active.length },
    productsWithSalePrices: validPriced.length,
    productsWithoutSalePrices: missingProducts.length,
    productsMissingOriginalPrice: active.filter((product) => product.originalPrice === null).length,
    productsWithInvalidPricing: criticalProducts.length,
    invalidPricing: summarize(allIssues, ['missing-selling-price', ...criticalCategories]),
    consistencyIssues: summarize(allIssues, consistencyCategories),
    productIssues: issueMap.filter((item) => item.issues.length > 0).map(({ product, issues }) => ({ id: product.id, name: product.name, categories: issues })),
    health: buildHealth(active.length, criticalProducts.length, missingProducts.length, consistencyProducts.length, coverage),
    discounts: { discountedProducts: discountCount, nonDiscountedProducts: active.length - discountCount, coveragePercentage: coverage, distribution: buckets },
    prices: {
      averageSellingPrice: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      medianSellingPrice: median(values),
      highestPricedProducts: high.slice(0, 5),
      lowestPricedProducts: low.slice(0, 5),
    },
  };
  return deepFreeze(metrics) as PricingMetrics;
}
