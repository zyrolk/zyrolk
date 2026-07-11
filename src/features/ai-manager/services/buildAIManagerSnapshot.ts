import type { AIDataSetId, AIDataSetReadiness, AIIntelligenceReadiness } from '../types/domain';
import type { AIManagerSnapshot, AIManagerSourceData } from '../types/snapshot';
import { INTELLIGENCE_CATALOG } from './intelligenceCatalog';

const DATA_SET_LABELS: Readonly<Record<AIDataSetId, string>> = Object.freeze({
  products: 'Products',
  'pricing-products': 'Products with cost or market pricing',
  categories: 'Categories',
  orders: 'Orders',
  customers: 'Customers (aggregate count only)',
  reviews: 'Reviews',
  'supplier-sources': 'Supplier sources',
  'supplier-review-queue': 'Supplier review queue',
  'supplier-sync-history': 'Supplier sync history',
  settings: 'Website settings',
});

function freezeSnapshot<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      freezeSnapshot(child as object);
    }
  });
  return Object.freeze(value);
}

export function calculateIntelligenceReadiness(
  dataSets: readonly AIDataSetReadiness[],
): readonly AIIntelligenceReadiness[] {
  const dataSetMap = new Map(dataSets.map((dataSet) => [dataSet.id, dataSet]));

  return INTELLIGENCE_CATALOG.map((entry) => {
    const missingRequiredDataSets = entry.requiredDataSets.filter(
      (id) => !dataSetMap.get(id)?.available,
    );
    const relevantDataSets = [...entry.requiredDataSets, ...entry.optionalDataSets]
      .map((id) => dataSetMap.get(id))
      .filter((dataSet): dataSet is AIDataSetReadiness => Boolean(dataSet));
    const hasAnyData = relevantDataSets.some((dataSet) => dataSet.available);
    const status = missingRequiredDataSets.length === 0
      ? 'ready'
      : hasAnyData
        ? 'limited'
        : 'unavailable';

    return {
      ...entry,
      status,
      availableDataSets: relevantDataSets.filter((dataSet) => dataSet.available),
      missingRequiredDataSets,
    };
  });
}

export function buildAIManagerSnapshot(source: AIManagerSourceData): AIManagerSnapshot {
  const products = [...source.products];
  const categories = [...source.categories];
  const orders = [...source.orders];
  const reviews = [...source.reviews];
  const supplierSources = [...source.supplierSources];
  const supplierReviewQueue = [...source.supplierReviewQueue];
  const supplierSyncHistory = [...source.supplierSyncHistory];
  const pricingProductCount = products.filter(
    (product) => typeof product.costPrice === 'number' || typeof product.marketPrice === 'number',
  ).length;

  const recordCounts: Readonly<Record<AIDataSetId, number>> = {
    products: products.length,
    'pricing-products': pricingProductCount,
    categories: categories.length,
    orders: orders.length,
    customers: source.customers.length,
    reviews: reviews.length,
    'supplier-sources': supplierSources.length,
    'supplier-review-queue': supplierReviewQueue.length,
    'supplier-sync-history': supplierSyncHistory.length,
    settings: source.settings ? 1 : 0,
  };

  const dataSets = (Object.keys(DATA_SET_LABELS) as AIDataSetId[]).map((id) => ({
    id,
    label: DATA_SET_LABELS[id],
    recordCount: recordCounts[id],
    available: recordCounts[id] > 0,
  }));

  const snapshot: AIManagerSnapshot = {
    metrics: {
      productCount: products.length,
      activeProductCount: products.filter((product) => product.isActive !== false).length,
      outOfStockCount: products.filter((product) => product.stock <= 0).length,
      lowStockCount: products.filter((product) => product.stock > 0 && product.stock <= 5).length,
      orderCount: orders.length,
      nonCancelledRevenue: orders
        .filter((order) => order.status !== 'cancelled')
        .reduce((total, order) => total + order.totalPrice, 0),
      customerCount: source.customers.length,
      reviewCount: reviews.length,
      pendingSupplierReviewCount: supplierReviewQueue.filter((item) => item.status === 'Pending').length,
    },
    sales: {
      orders: orders.map((order) => ({
        createdAt: order.createdAt,
        status: String(order.status || 'unknown').toLowerCase(),
        totalPrice: order.totalPrice,
        items: order.items.map((item) => ({
          productId: item.productId,
          productName: item.name,
          unitPrice: item.price,
          quantity: item.quantity,
        })),
      })),
    },
    inventory: {
      products: products.map((product) => ({
        id: product.id,
        name: product.name,
        stock: typeof product.stock === 'number' ? product.stock : null,
        isActive: product.isActive !== false,
      })),
    },
    dataSets,
    intelligence: calculateIntelligenceReadiness(dataSets),
    privacy: {
      containsCustomerRecords: false,
      containsDirectIdentifiers: false,
      mode: 'aggregate-only',
    },
  };

  return freezeSnapshot(snapshot) as AIManagerSnapshot;
}
