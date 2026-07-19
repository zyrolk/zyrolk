import { RawA2ZProduct } from '../connectors/a2z-website/types';
import { SyncConfig } from '../sync-engine/types';
import { Product } from '../../types';
import { SyncPipeline, PipelineResult } from './SyncPipeline';
import { HistoryPipeline, PreparedHistoryPayload } from './HistoryPipeline';

const debugIntegration = (...values: unknown[]): void => {
  if (typeof window !== 'undefined' && ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)) {
    console.info(...values);
  }
};

export interface IntegrationRunResult {
  success: boolean;
  totalProcessed: number;
  newProducts: number;
  priceChanges: number;
  stockChanges: number;
  imageChanges: number;
  descriptionChanges: number;
  failedCount: number;
  durationMs: number;
  results: PipelineResult[];
  preparedHistoryPayload?: PreparedHistoryPayload;
  error?: string;
}

export class IntegrationManager {
  /**
   * High-level entrypoint that orchestrates raw product integration.
   * Maps, validates, compares, and prepares queue, review, and history payloads.
   * Runs entirely in-memory: no Firestore reads or writes are executed.
   */
  public static async integrateRawProducts(
    supplierId: string,
    supplierName: string,
    rawProducts: RawA2ZProduct[],
    existingProducts: Product[],
    config: SyncConfig,
    triggeredBy: string = 'System Integration Agent'
  ): Promise<IntegrationRunResult> {
    const startTime = Date.now();
    debugIntegration(`[IntegrationManager] Starting integration of ${rawProducts.length} raw products for supplier: ${supplierName}`);

    // Index existing catalog items by supplier SKU
    const existingMap = new Map<string, Product>();
    existingProducts.forEach(p => {
      if (p.supplierItemCode) {
        existingMap.set(p.supplierItemCode.trim().toLowerCase(), p);
      }
    });

    const pipelineResults: PipelineResult[] = [];
    let newProducts = 0;
    let priceChanges = 0;
    let stockChanges = 0;
    let imageChanges = 0;
    let descriptionChanges = 0;
    let failedCount = 0;

    // Run each raw item through the cohesive execution pipeline
    for (const raw of rawProducts) {
      const skuNorm = String(raw.sku || '').trim().toLowerCase();
      const existing = existingMap.get(skuNorm);

      const res = await SyncPipeline.executeSingle(
        raw,
        existing,
        config,
        supplierId,
        supplierName
      );

      pipelineResults.push(res);

      if (res.status === 'error') {
        failedCount++;
      } else if (res.status === 'queued' && res.comparison) {
        const type = res.comparison.changeType;
        if (type === 'NEW_PRODUCT') newProducts++;
        else if (type === 'PRICE_CHANGED') priceChanges++;
        else if (type === 'STOCK_CHANGED') stockChanges++;
        else if (type === 'IMAGE_CHANGED') imageChanges++;
        else if (type === 'DESCRIPTION_CHANGED') descriptionChanges++;
      }
    }

    const durationMs = Date.now() - startTime;
    const totalPendingReviews = newProducts + priceChanges + stockChanges + imageChanges + descriptionChanges;

    let preparedHistoryPayload: PreparedHistoryPayload | undefined = undefined;

    try {
      // 8. HistoryPipeline (Placeholder) - Prepare execution summaries but do NOT persist them
      preparedHistoryPayload = await HistoryPipeline.prepareHistoryPayload({
        supplierId,
        supplierName,
        status: failedCount > 0 && failedCount === rawProducts.length ? 'failed' : 'success',
        error: failedCount === rawProducts.length ? 'All catalog items failed validation' : 'None',
        newProducts,
        priceChanges,
        stockChanges,
        imageChanges,
        pendingReviews: totalPendingReviews,
        triggeredBy,
        durationMs,
        processedCount: rawProducts.length
      });
    } catch (e) {
      console.warn('[IntegrationManager] Failed to prepare historical payload:', e);
    }

    debugIntegration(`[IntegrationManager] Integration run completed in ${durationMs}ms. Processed: ${rawProducts.length}, Failed: ${failedCount}`);

    return {
      success: true,
      totalProcessed: rawProducts.length,
      newProducts,
      priceChanges,
      stockChanges,
      imageChanges,
      descriptionChanges,
      failedCount,
      durationMs,
      results: pipelineResults,
      preparedHistoryPayload
    };
  }
}
