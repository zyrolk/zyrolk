import type {
  OrderBreakdown,
  ProductRanking,
  RevenueTrendPoint,
  SalesMetrics,
  SalesPeriodMetrics,
  SalesSnapshot,
  SalesSnapshotOrder,
  SalesTrendComparison,
} from '../types/sales';

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child as object);
    }
  });
  return Object.freeze(value);
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseOrderDate(order: SalesSnapshotOrder): Date | null {
  const parsed = new Date(order.createdAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isNonCancelled(order: SalesSnapshotOrder): boolean {
  return order.status.trim().toLowerCase() !== 'cancelled';
}

function validTotal(order: SalesSnapshotOrder): number {
  return Number.isFinite(order.totalPrice) ? order.totalPrice : 0;
}

function buildPeriod(
  label: string,
  orders: readonly SalesSnapshotOrder[],
  start: Date,
  endExclusive: Date,
): SalesPeriodMetrics {
  const matchingOrders = orders.filter((order) => {
    if (!isNonCancelled(order)) return false;
    const createdAt = parseOrderDate(order);
    return createdAt !== null && createdAt >= start && createdAt < endExclusive;
  });
  const revenue = matchingOrders.reduce((total, order) => total + validTotal(order), 0);

  return {
    label,
    startDate: localDateKey(start),
    endDate: localDateKey(addLocalDays(endExclusive, -1)),
    revenue,
    orderCount: matchingOrders.length,
    averageOrderValue: matchingOrders.length > 0 ? revenue / matchingOrders.length : null,
    hasSales: matchingOrders.length > 0,
  };
}

function compareValues(currentValue: number, previousValue: number): SalesTrendComparison {
  const absoluteChange = currentValue - previousValue;
  const direction = previousValue === 0 && currentValue > 0
    ? 'no-baseline'
    : absoluteChange > 0
      ? 'up'
      : absoluteChange < 0
        ? 'down'
        : 'flat';

  return {
    direction,
    absoluteChange,
    percentageChange: previousValue === 0
      ? currentValue === 0 ? 0 : null
      : (absoluteChange / previousValue) * 100,
    currentValue,
    previousValue,
  };
}

function buildProductRankings(orders: readonly SalesSnapshotOrder[]): {
  revenueRanking: ProductRanking;
  quantityRanking: ProductRanking;
} {
  interface ProductAccumulator {
    productId: string;
    productName: string;
    revenue: number;
    quantity: number;
    orderCount: number;
    orderIndexes: Set<number>;
  }

  const productMap = new Map<string, ProductAccumulator>();

  orders.forEach((order, orderIndex) => {
    if (!isNonCancelled(order)) return;
    order.items.forEach((item) => {
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) return;
      const unitPrice = Number.isFinite(item.unitPrice) ? item.unitPrice : 0;
      const productId = item.productId || item.productName;
      if (!productId) return;
      const current = productMap.get(productId) || {
        productId,
        productName: item.productName || 'Unnamed product',
        revenue: 0,
        quantity: 0,
        orderCount: 0,
        orderIndexes: new Set<number>(),
      };
      current.revenue += unitPrice * item.quantity;
      current.quantity += item.quantity;
      current.orderIndexes.add(orderIndex);
      current.orderCount = current.orderIndexes.size;
      productMap.set(productId, current);
    });
  });

  const products = [...productMap.values()].map(({ orderIndexes: _orderIndexes, ...product }) => product);
  const byRevenueDescending = [...products].sort((a, b) => b.revenue - a.revenue || a.productName.localeCompare(b.productName));
  const byRevenueAscending = [...products].sort((a, b) => a.revenue - b.revenue || a.productName.localeCompare(b.productName));
  const byQuantityDescending = [...products].sort((a, b) => b.quantity - a.quantity || a.productName.localeCompare(b.productName));
  const byQuantityAscending = [...products].sort((a, b) => a.quantity - b.quantity || a.productName.localeCompare(b.productName));

  return {
    revenueRanking: { highest: byRevenueDescending.slice(0, 5), lowest: byRevenueAscending.slice(0, 5) },
    quantityRanking: { highest: byQuantityDescending.slice(0, 5), lowest: byQuantityAscending.slice(0, 5) },
  };
}

function buildOrderBreakdown(orders: readonly SalesSnapshotOrder[]): OrderBreakdown {
  const statusMap = new Map<string, { orderCount: number; revenue: number }>();
  orders.forEach((order) => {
    const status = order.status.trim().toLowerCase() || 'unknown';
    const current = statusMap.get(status) || { orderCount: 0, revenue: 0 };
    current.orderCount += 1;
    current.revenue += validTotal(order);
    statusMap.set(status, current);
  });

  const preferredOrder = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'unknown'];
  const statuses = [...statusMap.entries()]
    .sort(([left], [right]) => {
      const leftIndex = preferredOrder.indexOf(left);
      const rightIndex = preferredOrder.indexOf(right);
      return (leftIndex === -1 ? preferredOrder.length : leftIndex)
        - (rightIndex === -1 ? preferredOrder.length : rightIndex)
        || left.localeCompare(right);
    })
    .map(([status, values]) => ({
      status,
      ...values,
      percentageOfOrders: orders.length > 0 ? (values.orderCount / orders.length) * 100 : 0,
    }));

  return { totalOrders: orders.length, statuses };
}

function buildRevenueTrend(
  orders: readonly SalesSnapshotOrder[],
  start: Date,
  days: number,
): readonly RevenueTrendPoint[] {
  const points = new Map<string, RevenueTrendPoint>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = addLocalDays(start, offset);
    const key = localDateKey(date);
    points.set(key, { date: key, revenue: 0, orderCount: 0 });
  }

  const endExclusive = addLocalDays(start, days);
  orders.forEach((order) => {
    if (!isNonCancelled(order)) return;
    const createdAt = parseOrderDate(order);
    if (!createdAt || createdAt < start || createdAt >= endExclusive) return;
    const key = localDateKey(createdAt);
    const current = points.get(key);
    if (!current) return;
    points.set(key, {
      date: key,
      revenue: current.revenue + validTotal(order),
      orderCount: current.orderCount + 1,
    });
  });

  return [...points.values()];
}

export function buildSalesMetrics(snapshot: SalesSnapshot, asOf: Date): SalesMetrics {
  if (Number.isNaN(asOf.getTime())) {
    throw new RangeError('Sales metrics require a valid as-of date.');
  }

  const orders = [...snapshot.orders];
  const todayStart = startOfLocalDay(asOf);
  const tomorrowStart = addLocalDays(todayStart, 1);
  const sevenDayStart = addLocalDays(todayStart, -6);
  const previousSevenDayStart = addLocalDays(todayStart, -13);
  const thirtyDayStart = addLocalDays(todayStart, -29);
  const today = buildPeriod('Today', orders, todayStart, tomorrowStart);
  const lastSevenDays = buildPeriod('Last 7 days', orders, sevenDayStart, tomorrowStart);
  const previousSevenDays = buildPeriod('Previous 7 days', orders, previousSevenDayStart, sevenDayStart);
  const lastThirtyDays = buildPeriod('Last 30 days', orders, thirtyDayStart, tomorrowStart);
  const nonCancelledOrders = orders.filter(isNonCancelled);
  const totalRevenue = nonCancelledOrders.reduce((total, order) => total + validTotal(order), 0);
  const rankings = buildProductRankings(orders);

  const metrics: SalesMetrics = {
    asOfDate: localDateKey(todayStart),
    hasOrders: orders.length > 0,
    hasNonCancelledSales: nonCancelledOrders.length > 0,
    today,
    lastSevenDays,
    lastThirtyDays,
    revenueSummary: {
      totalRevenue,
      totalOrderCount: nonCancelledOrders.length,
      averageOrderValue: nonCancelledOrders.length > 0 ? totalRevenue / nonCancelledOrders.length : null,
      currentSevenDays: lastSevenDays,
      previousSevenDays,
      revenueTrend: compareValues(lastSevenDays.revenue, previousSevenDays.revenue),
      orderTrend: compareValues(lastSevenDays.orderCount, previousSevenDays.orderCount),
    },
    revenueRanking: rankings.revenueRanking,
    quantityRanking: rankings.quantityRanking,
    orderBreakdown: buildOrderBreakdown(orders),
    revenueTrend: buildRevenueTrend(orders, thirtyDayStart, 30),
  };

  return deepFreeze(metrics) as SalesMetrics;
}
