import type {
  InventoryHealth,
  InventoryMetrics,
  InventorySnapshot,
  InventorySnapshotProduct,
  StockDistributionItem,
} from '../types/inventory';

export const LOW_STOCK_THRESHOLD = 5;

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object);
  });
  return Object.freeze(value);
}

function isValidStock(stock: number | null): stock is number {
  return typeof stock === 'number' && Number.isFinite(stock) && stock >= 0;
}

function percentage(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

function buildHealth(activeCount: number, affectedCount: number, outCount: number, invalidCount: number): InventoryHealth {
  if (activeCount === 0) {
    return {
      status: 'unavailable', label: 'Unavailable', affectedCount: 0, affectedPercentage: 0,
      reasoning: 'No active product records are available for inventory-health analysis.',
    };
  }
  const affectedPercentage = percentage(affectedCount, activeCount);
  if (outCount === 0 && invalidCount === 0 && affectedPercentage <= 10) {
    return {
      status: 'good', label: 'Good', affectedCount, affectedPercentage,
      reasoning: `No active products are out of stock or invalid, and ${affectedPercentage.toFixed(1)}% are low in stock (good threshold: at most 10%).`,
    };
  }
  if (affectedPercentage <= 25) {
    return {
      status: 'attention', label: 'Needs attention', affectedCount, affectedPercentage,
      reasoning: `${affectedCount} of ${activeCount} active products (${affectedPercentage.toFixed(1)}%) are low, out of stock, or have invalid stock (attention threshold: at most 25%).`,
    };
  }
  return {
    status: 'critical', label: 'Critical', affectedCount, affectedPercentage,
    reasoning: `${affectedCount} of ${activeCount} active products (${affectedPercentage.toFixed(1)}%) are low, out of stock, or have invalid stock, exceeding the 25% attention threshold.`,
  };
}

export function buildInventoryMetrics(snapshot: InventorySnapshot): InventoryMetrics {
  const products = [...snapshot.products];
  const activeProducts = products.filter((product) => product.isActive);
  const validActive = activeProducts.filter((product) => isValidStock(product.stock));
  const invalidActive = activeProducts.filter((product) => !isValidStock(product.stock));
  const inStock = validActive.filter((product) => product.stock > 0);
  const outOfStock = validActive.filter((product) => product.stock === 0);
  const lowStock = validActive
    .filter((product): product is InventorySnapshotProduct & { readonly stock: number } => (
      product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD
    ))
    .sort((left, right) => left.stock - right.stock || left.name.localeCompare(right.name));
  const healthyStock = validActive.filter((product) => product.stock > LOW_STOCK_THRESHOLD);
  const activeCount = activeProducts.length;
  const distribution: StockDistributionItem[] = [
    { key: 'healthy', label: 'Healthy stock', count: healthyStock.length, percentage: percentage(healthyStock.length, activeCount) },
    { key: 'low', label: 'Low stock', count: lowStock.length, percentage: percentage(lowStock.length, activeCount) },
    { key: 'out', label: 'Out of stock', count: outOfStock.length, percentage: percentage(outOfStock.length, activeCount) },
    { key: 'invalid', label: 'Invalid stock data', count: invalidActive.length, percentage: percentage(invalidActive.length, activeCount) },
  ];
  const affectedCount = lowStock.length + outOfStock.length + invalidActive.length;

  const metrics: InventoryMetrics = {
    hasProducts: products.length > 0,
    summary: {
      totalProducts: products.length,
      activeProducts: activeCount,
      inactiveProducts: products.length - activeCount,
      inStockProducts: inStock.length,
      outOfStockProducts: outOfStock.length,
      lowStockProducts: lowStock.length,
      invalidStockProducts: invalidActive.length,
    },
    health: buildHealth(activeCount, affectedCount, outOfStock.length, invalidActive.length),
    stockDistribution: { activeProductCount: activeCount, items: distribution },
    lowStockProducts: lowStock.map(({ id, name, stock }) => ({ id, name, stock })),
  };

  return deepFreeze(metrics) as InventoryMetrics;
}
