import { RawA2ZProduct } from '../connectors/a2z-website/types';
import { InboundProduct, SyncConfig, ProductComparisonResult, ImportQueueEntry } from '../sync-engine/types';
import { Product } from '../../types';
import { ValidationPipeline } from './ValidationPipeline';
import { MappingPipeline } from './MappingPipeline';
import { ComparisonPipeline } from './ComparisonPipeline';
import { QueuePipeline } from './QueuePipeline';
import { ReviewPipeline, PreparedReviewPayload } from './ReviewPipeline';
import { ProductParser } from '../connectors/a2z-website/ProductParser';

export interface PipelineResult {
  sku: string;
  status: 'ignored' | 'queued' | 'error';
  comparison?: ProductComparisonResult;
  errors?: string[];
  preparedReview?: PreparedReviewPayload;
  preparedQueue?: ImportQueueEntry;
}

export class SyncPipeline {
  /**
   * Runs a raw or unstructured A2Z product through the entire integrated pipeline:
   * parsing -> raw validation -> mapping -> mapped validation -> database comparison -> review/import registration.
   * 
   * This operates as a pure data pipeline: no live Firestore queries or writes are executed.
   * All results are returned as comparison-ready prepared payloads.
   * 
   * @param rawInput The raw product payload (either JSON string or object)
   * @param existing An optional existing local catalog item matching this sku
   * @param config Synchronization configuration metrics
   * @param supplierId The source identifier running the pipeline
   * @param supplierName The display name of the supplier
   */
  public static async executeSingle(
    rawInput: string | RawA2ZProduct,
    existing: Product | undefined,
    config: SyncConfig,
    supplierId: string,
    supplierName: string
  ): Promise<PipelineResult> {
    let sku = 'UNKNOWN';

    try {
      // 1. ProductParser
      const raw: RawA2ZProduct = typeof rawInput === 'string'
        ? ProductParser.parseJsonPayload(rawInput)
        : ProductParser.parseJsonPayload(rawInput); // Normalize fields via parser

      sku = raw.sku || 'UNKNOWN';

      // 2. ProductValidator (Raw)
      const rawValidation = await ValidationPipeline.validateRawProduct(raw);
      if (!rawValidation.isValid) {
        console.error(`[SyncPipeline] Raw product validation failed for SKU ${sku}:`, rawValidation.errors);
        return { sku, status: 'error', errors: rawValidation.errors };
      }

      // 3. ProductMapper
      const mapped = await MappingPipeline.mapProduct(raw);

      // 4. ProductValidator (Mapped)
      const mappedValidation = await ValidationPipeline.validateMappedProduct(mapped);
      if (!mappedValidation.isValid) {
        console.error(`[SyncPipeline] Mapped product validation failed for SKU ${sku}:`, mappedValidation.errors);
        return { sku, status: 'error', errors: mappedValidation.errors };
      }

      // 5. ProductComparator (internally orchestrates PriceComparator, StockComparator, ImageComparator)
      const comparison = await ComparisonPipeline.compareProduct(existing, mapped, config);

      if (!comparison.hasChanges) {
        console.log(`[SyncPipeline] No fluctuations detected for SKU ${sku}. Discarding pipeline state.`);
        return { sku, status: 'ignored', comparison };
      }

      // 6. QueuePipeline (Placeholder) - prepare image download and ingestion queue payload
      let preparedQueue: ImportQueueEntry | undefined = undefined;
      let preparedReview: PreparedReviewPayload | undefined = undefined;

      let oldValueText = '';
      let newValueText = '';

      if (comparison.changeType === 'NEW_PRODUCT') {
        oldValueText = 'None (New Product)';
        newValueText = `Price: LKR ${comparison.priceDetails?.newPrice}, Stock: ${comparison.stockDetails?.newStock}`;

        // Prepare download/import queue payload if auto-download is active and images are available
        if (config.autoImageDownload && mapped.imageUrls.length > 0) {
          preparedQueue = await QueuePipeline.prepareQueueEntryPayload(
            sku,
            supplierName,
            mapped.name,
            'Website',
            mapped.imageUrls.length
          );
        }
      } else if (comparison.changeType === 'PRICE_CHANGED' && comparison.priceDetails) {
        oldValueText = `Cost: LKR ${comparison.priceDetails.oldCostPrice}, Retail: LKR ${comparison.priceDetails.oldPrice}`;
        newValueText = `Cost: LKR ${comparison.priceDetails.newCostPrice}, Retail: LKR ${comparison.priceDetails.newPrice}`;
      } else if (comparison.changeType === 'STOCK_CHANGED' && comparison.stockDetails) {
        oldValueText = `Stock: ${comparison.stockDetails.oldStock}`;
        newValueText = `Stock: ${comparison.stockDetails.newStock}`;
      } else if (comparison.changeType === 'IMAGE_CHANGED' && comparison.imageDetails) {
        oldValueText = `${existing?.imageUrls?.length || 0} images`;
        newValueText = `${comparison.imageDetails.finalUrls.length} images (${comparison.imageDetails.addedUrls.length} added)`;

        // Prepare image download queue payload for the added image counts
        if (config.autoImageDownload && comparison.imageDetails.addedUrls.length > 0) {
          preparedQueue = await QueuePipeline.prepareQueueEntryPayload(
            sku,
            supplierName,
            mapped.name,
            'Website',
            comparison.imageDetails.addedUrls.length
          );
        }
      } else if (comparison.changeType === 'DESCRIPTION_CHANGED') {
        oldValueText = (comparison.oldName || '') + ' | ' + (comparison.oldDescription || '').substring(0, 30) + '...';
        newValueText = (comparison.newName || '') + ' | ' + (comparison.newDescription || '').substring(0, 30) + '...';
      }

      // 7. ReviewPipeline (Placeholder) - prepare the submission payload
      preparedReview = await ReviewPipeline.prepareReviewPayload({
        supplierCode: supplierId.toUpperCase(),
        supplierName,
        productName: mapped.name,
        source: 'Website',
        changeType: comparison.changeType as any,
        oldValue: oldValueText,
        newValue: newValueText
      });

      console.log(`[SyncPipeline] Successfully prepared payloads for SKU ${sku}`);

      return {
        sku,
        status: 'queued',
        comparison,
        preparedReview,
        preparedQueue
      };

    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`[SyncPipeline] Unexpected exception in pipeline run for SKU ${sku}:`, errorMsg);
      return { sku, status: 'error', errors: [errorMsg] };
    }
  }
}
