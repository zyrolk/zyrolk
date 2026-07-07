import { collection, getDoc, getDocs, doc } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../../firebase';
import { Product } from '../../types';
import { 
  InboundProduct, 
  SyncConfig, 
  ProductComparisonResult 
} from './types';
import { SourceRegistry } from './SourceRegistry';
import { ProductComparator } from './ProductComparator';
import { QueueManager } from './QueueManager';
import { ReviewManager } from './ReviewManager';
import { HistoryLogger } from './HistoryLogger';

export interface SyncRunResult {
  success: boolean;
  error?: string;
  processedCount: number;
  newProducts: number;
  priceChanges: number;
  stockChanges: number;
  imageChanges: number;
  pendingReviews: number;
  durationMs: number;
}

export class SyncManager {
  /**
   * Orchestrates a complete synchronization cycle for a specific supplier source.
   * Processes a structured list of inbound products extracted from a supplier's feed/channel,
   * performs multi-layered comparisons, triggers manual reviews & image downloads, and logs history.
   * 
   * @param sourceId The identifier of the supplier source to run sync against
   * @param inboundProducts Array of structured inbound products parsed from the supplier feed
   * @param triggeredBy Actor or channel initiating the run (e.g. "Admin Manual Run", "Cron Ingestion")
   */
  public static async runSync(
    sourceId: string,
    inboundProducts: InboundProduct[],
    triggeredBy: string = "Admin Manual Run"
  ): Promise<SyncRunResult> {
    const startTime = Date.now();
    
    // Initial metrics
    let newProducts = 0;
    let priceChanges = 0;
    let stockChanges = 0;
    let imageChanges = 0;
    let pendingReviews = 0;
    let processedCount = 0;

    // 1. Fetch the Supplier Source profile
    const source = await SourceRegistry.getSourceById(sourceId);
    if (!source) {
      throw new Error(`Supplier source with ID ${sourceId} does not exist in registry.`);
    }

    try {
      // 2. Fetch the Active Configurations
      const configDoc = await getDoc(doc(db, "supplier_settings", "config"));
      const config: SyncConfig = configDoc.exists() 
        ? (configDoc.data() as SyncConfig)
        : {
            websiteSyncEnabled: false,
            whatsappSyncEnabled: false,
            autoSyncEnabled: true,
            autoImageDownload: true,
            notificationEnabled: true,
            syncInterval: "1 Hour",
            defaultProfitMargin: 15,
            defaultMarkup: 10,
            defaultImageLimit: 5,
            lastUpdated: new Date().toISOString(),
            updatedBy: "System"
          };

      // 3. Retrieve all existing catalog items to match against
      const productsSnap = await getDocs(collection(db, "products"));
      const existingProducts: Product[] = [];
      productsSnap.forEach(d => {
        existingProducts.push({ id: d.id, ...d.data() } as Product);
      });

      // Map existing products by supplierItemCode for O(1) matching
      const productMap = new Map<string, Product>();
      existingProducts.forEach(p => {
        if (p.supplierItemCode) {
          productMap.set(p.supplierItemCode, p);
        }
      });

      // 4. Iterate and compare each inbound product
      for (const inbound of inboundProducts) {
        const existing = productMap.get(inbound.supplierItemCode);
        const comparison: ProductComparisonResult = ProductComparator.compare(existing, inbound, config);
        
        processedCount++;

        if (comparison.hasChanges) {
          // Increment specific counters and submit changes to queues
          let oldValueText = "";
          let newValueText = "";

          if (comparison.changeType === 'NEW_PRODUCT') {
            newProducts++;
            oldValueText = "None (New Product)";
            newValueText = `Price: LKR ${comparison.priceDetails?.newPrice}, Stock: ${comparison.stockDetails?.newStock}`;

            // Create download/import queue entry if images exist and auto-download is on
            if (config.autoImageDownload && inbound.imageUrls.length > 0) {
              await QueueManager.createQueueEntry(
                sourceId.toUpperCase(),
                source.name,
                inbound.name,
                source.type,
                inbound.imageUrls.length
              );
            }
          } else if (comparison.changeType === 'PRICE_CHANGED' && comparison.priceDetails) {
            priceChanges++;
            oldValueText = `Cost: LKR ${comparison.priceDetails.oldCostPrice}, Retail: LKR ${comparison.priceDetails.oldPrice}`;
            newValueText = `Cost: LKR ${comparison.priceDetails.newCostPrice}, Retail: LKR ${comparison.priceDetails.newPrice}`;
          } else if (comparison.changeType === 'STOCK_CHANGED' && comparison.stockDetails) {
            stockChanges++;
            oldValueText = `Stock: ${comparison.stockDetails.oldStock}`;
            newValueText = `Stock: ${comparison.stockDetails.newStock}`;
          } else if (comparison.changeType === 'IMAGE_CHANGED' && comparison.imageDetails) {
            imageChanges++;
            oldValueText = `${existing?.imageUrls?.length || 0} images`;
            newValueText = `${comparison.imageDetails.finalUrls.length} images (${comparison.imageDetails.addedUrls.length} added)`;

            // Queue images for download
            if (config.autoImageDownload && comparison.imageDetails.addedUrls.length > 0) {
              await QueueManager.createQueueEntry(
                sourceId.toUpperCase(),
                source.name,
                inbound.name,
                source.type,
                comparison.imageDetails.addedUrls.length
              );
            }
          } else if (comparison.changeType === 'DESCRIPTION_CHANGED') {
            oldValueText = (comparison.oldName || "") + " | " + (comparison.oldDescription || "").substring(0, 30) + "...";
            newValueText = (comparison.newName || "") + " | " + (comparison.newDescription || "").substring(0, 30) + "...";
          }

          // Submit to the human-in-the-loop review queue
          await ReviewManager.submitToReviewQueue({
            supplierCode: sourceId.toUpperCase(),
            supplierName: source.name,
            productName: inbound.name,
            source: source.type,
            changeType: comparison.changeType as any,
            oldValue: oldValueText,
            newValue: newValueText
          });

          pendingReviews++;
        }
      }

      const durationMs = Date.now() - startTime;

      // 5. Save sync run summaries to persistent logs
      await HistoryLogger.logSyncRun({
        supplierId: sourceId,
        supplierName: source.name,
        status: 'success',
        error: 'None',
        newProducts,
        priceChanges,
        stockChanges,
        imageChanges,
        pendingReviews,
        triggeredBy,
        durationMs,
        processedCount
      });

      // 6. Update Supplier Source operational metrics
      const nowIso = new Date().toISOString();
      await SourceRegistry.updateSyncStatus(sourceId, {
        connectionStatus: 'connected',
        lastSync: nowIso,
        lastError: 'None',
        newProducts: (source.newProducts || 0) + newProducts,
        priceChanges: (source.priceChanges || 0) + priceChanges,
        stockChanges: (source.stockChanges || 0) + stockChanges,
        imageChanges: (source.imageChanges || 0) + imageChanges,
        pendingReviews: (source.pendingReviews || 0) + pendingReviews
      });

      return {
        success: true,
        processedCount,
        newProducts,
        priceChanges,
        stockChanges,
        imageChanges,
        pendingReviews,
        durationMs
      };

    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log failure in history
      await HistoryLogger.logSyncRun({
        supplierId: sourceId,
        supplierName: source.name,
        status: 'failed',
        error: errorMessage,
        newProducts,
        priceChanges,
        stockChanges,
        imageChanges,
        pendingReviews,
        triggeredBy,
        durationMs,
        processedCount
      });

      // Update source registry status with the error details
      await SourceRegistry.updateSyncStatus(sourceId, {
        connectionStatus: 'disconnected',
        lastError: errorMessage
      });

      return {
        success: false,
        error: errorMessage,
        processedCount,
        newProducts,
        priceChanges,
        stockChanges,
        imageChanges,
        pendingReviews,
        durationMs
      };
    }
  }
}
