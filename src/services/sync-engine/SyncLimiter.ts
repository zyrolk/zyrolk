export type SyncMode = 'Single Product' | 'Product Count' | 'Category' | 'Supplier Code Range' | 'Full Catalog';

export type SyncLimitValue = 1 | 5 | 10 | 25 | 50 | 100 | 250 | 500 | 'Unlimited' | number;

export interface SyncLimit {
  value: SyncLimitValue;
  customLabel?: string;
}

export interface SyncSummary {
  totalProducts: number;
  selectedProducts: number;
  remainingProducts: number;
  syncLimit: string | number;
  syncMode: SyncMode;
  estimatedBatches: number;
  currentBatch: number;
  remainingBatches: number;
}

export interface SyncPlan {
  mode: SyncMode;
  limit: SyncLimitValue;
  selectedProducts: any[];
  remainingProducts: any[];
  summary: SyncSummary;
  resumePoint?: SyncResumePoint;
}

export interface SyncProgress {
  totalToSync: number;
  syncedCount: number;
  failedCount: number;
  currentBatchIndex: number;
  totalBatches: number;
  isCompleted: boolean;
  isPaused: boolean;
  lastActiveTimestamp: number;
}

export interface SyncBatch {
  batchIndex: number;
  productIds: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface SyncResumePoint {
  sessionId: string;
  lastProcessedSku: string | null;
  processedCount: number;
  remainingCount: number;
  totalCount: number;
  batchSize: number;
  currentBatchIndex: number;
  serializedState?: string;
}

/**
 * Service to plan, filter, and apply precise synchronization limiters
 * on inbound products from supplier feeds.
 * Done entirely in-memory to safely control sync payloads.
 */
export class SyncLimiter {
  /**
   * Slices/limits the input product list by the maximum sync constraint.
   */
  public static async limitProducts<T>(products: T[], limit: SyncLimitValue): Promise<T[]> {
    if (limit === 'Unlimited') {
      return products;
    }
    const limitNum = typeof limit === 'number' ? limit : parseInt(String(limit), 10);
    if (isNaN(limitNum) || limitNum <= 0) {
      return products;
    }
    return products.slice(0, limitNum);
  }

  /**
   * Filters product lists to a specific category segment.
   */
  public static async filterByCategory<T extends { category?: string }>(products: T[], category: string): Promise<T[]> {
    if (!category) return products;
    const lowerCategory = category.trim().toLowerCase();
    return products.filter(p => (p.category || '').trim().toLowerCase() === lowerCategory);
  }

  /**
   * Filters products within a specific supplier item code or SKU range lexicographically.
   */
  public static async filterBySupplierCodes<T extends { supplierItemCode?: string; sku?: string }>(
    products: T[],
    startCode: string,
    endCode: string
  ): Promise<T[]> {
    if (!startCode && !endCode) return products;
    const start = (startCode || '').trim().toLowerCase();
    const end = (endCode || '').trim().toLowerCase();

    return products.filter(p => {
      const code = (p.supplierItemCode || p.sku || '').trim().toLowerCase();
      if (!code) return false;
      if (start && code < start) return false;
      if (end && code > end) return false;
      return true;
    });
  }

  /**
   * Isolates a single product by its supplier code or SKU.
   */
  public static async filterSingleProduct<T extends { supplierItemCode?: string; sku?: string }>(
    products: T[],
    code: string
  ): Promise<T[]> {
    if (!code) return [];
    const targetCode = code.trim().toLowerCase();
    return products.filter(p => {
      const pCode = (p.supplierItemCode || p.sku || '').trim().toLowerCase();
      return pCode === targetCode;
    });
  }

  /**
   * Computes the remaining products that were not selected for synchronization.
   */
  public static async calculateRemainingProducts(totalCount: number, selectedCount: number): Promise<number> {
    const remaining = totalCount - selectedCount;
    return remaining < 0 ? 0 : remaining;
  }

  /**
   * Formulates a standard, structured in-memory SyncSummary representation.
   */
  public static async returnSyncSummary(
    totalCount: number,
    selectedCount: number,
    limit: SyncLimitValue,
    mode: SyncMode,
    batchSize: number = 50
  ): Promise<SyncSummary> {
    const remaining = await this.calculateRemainingProducts(totalCount, selectedCount);
    const estimatedBatches = selectedCount > 0 ? Math.ceil(selectedCount / batchSize) : 0;
    const currentBatch = estimatedBatches > 0 ? 1 : 0;
    const remainingBatches = estimatedBatches > 0 ? estimatedBatches - 1 : 0;

    return {
      totalProducts: totalCount,
      selectedProducts: selectedCount,
      remainingProducts: remaining,
      syncLimit: typeof limit === 'number' ? limit : String(limit),
      syncMode: mode,
      estimatedBatches,
      currentBatch,
      remainingBatches
    };
  }

  /**
   * Formulates a comprehensive synchronization plan in-memory.
   */
  public static async prepareSyncPlan<T extends { category?: string; supplierItemCode?: string; sku?: string }>(
    products: T[],
    mode: SyncMode,
    limit: SyncLimitValue,
    options?: {
      category?: string;
      startCode?: string;
      endCode?: string;
      singleProductCode?: string;
      batchSize?: number;
    }
  ): Promise<SyncPlan> {
    let filtered = [...products];

    // 1. Filter based on Selected Mode
    switch (mode) {
      case 'Single Product':
        filtered = await this.filterSingleProduct(filtered, options?.singleProductCode || '');
        break;
      case 'Category':
        filtered = await this.filterByCategory(filtered, options?.category || '');
        break;
      case 'Supplier Code Range':
        filtered = await this.filterBySupplierCodes(filtered, options?.startCode || '', options?.endCode || '');
        break;
      case 'Product Count':
      case 'Full Catalog':
      default:
        // No pre-filtering by category or code
        break;
    }

    // 2. Apply Limit Constraint
    const selectedProducts = await this.limitProducts(filtered, limit);

    // 3. Determine remaining products in the catalog
    const selectedSet = new Set(selectedProducts);
    const remainingProducts = products.filter(p => !selectedSet.has(p));

    // 4. Formulate summary statistics
    const batchSize = options?.batchSize || 50;
    const summary = await this.returnSyncSummary(products.length, selectedProducts.length, limit, mode, batchSize);

    // 5. Build future resume point if selected products have remaining
    let resumePoint: SyncResumePoint | undefined = undefined;
    if (selectedProducts.length < products.length && selectedProducts.length > 0) {
      const lastProduct = selectedProducts[selectedProducts.length - 1];
      const lastSku = lastProduct ? (lastProduct.supplierItemCode || lastProduct.sku || null) : null;
      resumePoint = {
        sessionId: `sess_${Date.now()}_resume`,
        lastProcessedSku: lastSku,
        processedCount: selectedProducts.length,
        remainingCount: products.length - selectedProducts.length,
        totalCount: products.length,
        batchSize,
        currentBatchIndex: 0
      };
    }

    return {
      mode,
      limit,
      selectedProducts,
      remainingProducts,
      summary,
      resumePoint
    };
  }
}
