import type {
  AnonymousCustomerPurchaseProfile,
  CustomerHealth,
  CustomerMetrics,
  CustomerRetentionPeriod,
  CustomerSnapshot,
} from '../types/customer';

export const HEALTHY_REPEAT_RATE_THRESHOLD = 30 as const;
export const HEALTHY_ORDER_FREQUENCY_THRESHOLD = 1.5 as const;

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => { if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object); });
  return Object.freeze(value);
}
function startOfLocalDay(value: Date): Date { return new Date(value.getFullYear(), value.getMonth(), value.getDate()); }
function addLocalDays(value: Date, days: number): Date { return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days); }
function dateKey(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function validDates(profile: AnonymousCustomerPurchaseProfile): readonly Date[] { return profile.orderDates.map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime())).sort((a, b) => a.getTime() - b.getTime()); }
function percent(count: number, total: number): number { return total > 0 ? (count / total) * 100 : 0; }

function retentionPeriod(label: string, profiles: readonly AnonymousCustomerPurchaseProfile[], start: Date, endExclusive: Date): CustomerRetentionPeriod {
  const active = profiles.filter((profile) => validDates(profile).some((date) => date >= start && date < endExclusive));
  const retained = active.filter((profile) => {
    const dates = validDates(profile);
    return dates.some((date) => date < start) && dates.some((date) => date >= start && date < endExclusive);
  });
  return {
    label, startDate: dateKey(start), endDate: dateKey(addLocalDays(endExclusive, -1)),
    activeCustomers: active.length, retainedCustomers: retained.length,
    retentionRate: active.length > 0 ? percent(retained.length, active.length) : null,
  };
}

function buildHealth(profileCount: number, returning: number, repeatRate: number, averageOrders: number | null): CustomerHealth {
  if (profileCount === 0) return { status: 'critical', label: 'Critical', reasons: ['No usable non-cancelled customer purchase history is available.'], repeatRateThreshold: HEALTHY_REPEAT_RATE_THRESHOLD, orderFrequencyThreshold: HEALTHY_ORDER_FREQUENCY_THRESHOLD };
  if (returning === 0) return { status: 'critical', label: 'Critical', reasons: [`0 of ${profileCount} active purchasing customers made multiple purchases.`], repeatRateThreshold: HEALTHY_REPEAT_RATE_THRESHOLD, orderFrequencyThreshold: HEALTHY_ORDER_FREQUENCY_THRESHOLD };
  const reasons: string[] = [];
  if (repeatRate < HEALTHY_REPEAT_RATE_THRESHOLD) reasons.push(`Repeat purchase rate is ${repeatRate.toFixed(1)}%, below the documented 30% healthy threshold.`);
  if (averageOrders === null || averageOrders < HEALTHY_ORDER_FREQUENCY_THRESHOLD) reasons.push(`Average order frequency is ${averageOrders?.toFixed(2) || 'unavailable'}, below the documented 1.5-order healthy threshold.`);
  return reasons.length
    ? { status: 'attention', label: 'Needs attention', reasons, repeatRateThreshold: HEALTHY_REPEAT_RATE_THRESHOLD, orderFrequencyThreshold: HEALTHY_ORDER_FREQUENCY_THRESHOLD }
    : { status: 'healthy', label: 'Healthy', reasons: [`${returning} of ${profileCount} active purchasing customers repeat purchased (${repeatRate.toFixed(1)}%), and average frequency meets 1.5 orders.`], repeatRateThreshold: HEALTHY_REPEAT_RATE_THRESHOLD, orderFrequencyThreshold: HEALTHY_ORDER_FREQUENCY_THRESHOLD };
}

export function buildCustomerMetrics(snapshot: CustomerSnapshot, asOf: Date): CustomerMetrics {
  if (Number.isNaN(asOf.getTime())) throw new RangeError('Customer metrics require a valid as-of date.');
  const profiles = [...snapshot.purchaseProfiles];
  const today = startOfLocalDay(asOf);
  const tomorrow = addLocalDays(today, 1);
  const currentStart = addLocalDays(today, -29);
  const previousStart = addLocalDays(today, -59);
  const current = retentionPeriod('Current 30 days', profiles, currentStart, tomorrow);
  const previous = retentionPeriod('Previous 30 days', profiles, previousStart, currentStart);
  const change = previous.retentionRate === null || current.retentionRate === null ? null : current.retentionRate - previous.retentionRate;
  const trend = change === null ? 'unavailable' : change > 0 ? 'improving' : change < 0 ? 'declining' : 'unchanged';
  const returning = profiles.filter((profile) => profile.orderCount >= 2).length;
  const singles = profiles.filter((profile) => profile.orderCount === 1).length;
  const totalOrders = profiles.reduce((sum, profile) => sum + profile.orderCount, 0);
  const totalValue = profiles.reduce((sum, profile) => sum + (Number.isFinite(profile.lifetimeValue) && profile.lifetimeValue >= 0 ? profile.lifetimeValue : 0), 0);
  const repeatRate = percent(returning, profiles.length);
  const averageOrders = profiles.length > 0 ? totalOrders / profiles.length : null;
  const newCustomers = profiles.filter((profile) => {
    const first = validDates(profile)[0];
    return first && first >= currentStart && first < tomorrow;
  }).length;

  const metrics: CustomerMetrics = {
    asOfDate: dateKey(today), hasUsableHistory: profiles.length > 0,
    totalCustomers: snapshot.customerRecordCount,
    activePurchasingCustomers: profiles.length,
    newCustomers,
    returningCustomers: returning,
    repeatPurchaseRate: repeatRate,
    averageOrdersPerCustomer: averageOrders,
    averageCustomerLifetimeValue: profiles.length > 0 ? totalValue / profiles.length : null,
    customersWithMultiplePurchases: returning,
    customersWithSinglePurchase: singles,
    excludedOrderCount: snapshot.excludedOrderCount,
    retention: { current, previous, trend, percentagePointChange: change },
    health: buildHealth(profiles.length, returning, repeatRate, averageOrders),
  };
  return deepFreeze(metrics) as CustomerMetrics;
}
