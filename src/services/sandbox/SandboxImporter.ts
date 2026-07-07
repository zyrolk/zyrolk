import { Product, SupplierReviewQueueItem } from '../../types';
import { InboundProduct, ImportQueueEntry, SyncHistoryEntry } from '../sync-engine/types';
import { SandboxProductPreview, SandboxApprovalPayload, SandboxRollbackPayload } from './SandboxTypes';

export class SandboxImporter {
  /**
   * Prepares the approval and rollback payloads in-memory.
   * Does NOT perform database writes or network calls.
   */
  public static async prepareImportPayloads(params: {
    sessionId: string;
    supplierId: string;
    supplierName: string;
    previews: SandboxProductPreview[];
    existingProducts: Product[];
    triggeredBy?: string;
  }): Promise<{
    approvalPayload: SandboxApprovalPayload;
    rollbackPayload: SandboxRollbackPayload;
  }> {
    const { sessionId, supplierId, supplierName, previews, existingProducts, triggeredBy = 'Sandbox Automated Process' } = params;

    const productsToCreate: Product[] = [];
    const productsToUpdate: Array<{ id: string; updates: Partial<Product> }> = [];
    const originalProducts: Product[] = [];
    const createdProductIds: string[] = [];

    const reviewQueueItems: SupplierReviewQueueItem[] = [];
    const pendingChangesItems: any[] = [];
    const importQueueEntries: ImportQueueEntry[] = [];

    const timestamp = new Date().toISOString();
    const existingMap = new Map<string, Product>();
    existingProducts.forEach(p => {
      if (p.supplierItemCode) {
        existingMap.set(p.supplierItemCode.trim().toLowerCase(), p);
      }
    });

    let newProductsCount = 0;
    let priceChangesCount = 0;
    let stockChangesCount = 0;
    let imageChangesCount = 0;
    let descriptionChangesCount = 0;

    for (const preview of previews) {
      if (preview.action === 'ERROR' || preview.action === 'SKIP' || !preview.mappedInbound) {
        continue;
      }

      const inbound = preview.mappedInbound;
      const skuNorm = (inbound.supplierItemCode || '').trim().toLowerCase();
      const existing = existingMap.get(skuNorm);

      const revId = `rev-${sessionId}-${Math.floor(Math.random() * 100000)}`;

      if (preview.action === 'CREATE') {
        const prodId = `prod-sandbox-${Math.floor(Math.random() * 1000000)}`;
        newProductsCount++;
        createdProductIds.push(prodId);

        const calculatedPrice = preview.comparison?.priceDetails?.newPrice || inbound.costPrice;

        const newProduct: Product = {
          id: prodId,
          name: inbound.name,
          description: inbound.description || '',
          price: calculatedPrice,
          originalPrice: calculatedPrice,
          imageUrl: inbound.imageUrls?.[0] || '',
          imageUrls: inbound.imageUrls || [],
          category: inbound.category || 'general',
          rating: 5,
          reviewsCount: 0,
          isNew: true,
          isActive: true,
          sku: inbound.supplierItemCode,
          stock: inbound.stock,
          specs: {},
          createdAt: timestamp,
          supplierItemCode: inbound.supplierItemCode,
          costPrice: inbound.costPrice,
        };

        productsToCreate.push(newProduct);

        // Prepare Review Item
        reviewQueueItems.push({
          id: revId,
          supplierCode: supplierId.toUpperCase(),
          supplierName,
          productName: inbound.name,
          source: 'Website',
          changeType: 'NEW_PRODUCT',
          oldValue: 'None (Sandbox)',
          newValue: `Price: LKR ${calculatedPrice}, Stock: ${inbound.stock}`,
          status: 'Pending',
          createdAt: timestamp
        });

        // Prepare Pending Change Mirror
        pendingChangesItems.push({
          id: revId,
          supplierCode: supplierId.toUpperCase(),
          productName: inbound.name,
          changeType: 'NEW_PRODUCT',
          status: 'Pending',
          createdAt: timestamp,
          payload: {
            oldValue: 'None (Sandbox)',
            newValue: `Price: LKR ${calculatedPrice}, Stock: ${inbound.stock}`
          }
        });

        // Prepare Image Import Queue if images are present
        if (inbound.imageUrls && inbound.imageUrls.length > 0) {
          importQueueEntries.push({
            id: `imp-sandbox-${Math.floor(Math.random() * 100000)}`,
            supplierCode: inbound.supplierItemCode || '',
            supplierName,
            productName: inbound.name,
            source: 'Website',
            importStatus: 'Pending',
            progress: 0,
            totalImages: inbound.imageUrls.length,
            downloadedImages: 0,
            createdAt: timestamp
          });
        }
      } else if (preview.action === 'UPDATE' && existing) {
        originalProducts.push({ ...existing });

        const comp = preview.comparison;
        const updates: Partial<Product> = {};

        if (comp) {
          if (comp.changeType === 'PRICE_CHANGED' && comp.priceDetails) {
            priceChangesCount++;
            updates.price = comp.priceDetails.newPrice;
            updates.costPrice = comp.priceDetails.newCostPrice;
          } else if (comp.changeType === 'STOCK_CHANGED' && comp.stockDetails) {
            stockChangesCount++;
            updates.stock = comp.stockDetails.newStock;
          } else if (comp.changeType === 'IMAGE_CHANGED' && comp.imageDetails) {
            imageChangesCount++;
            updates.imageUrl = comp.imageDetails.finalUrls[0] || '';
            updates.imageUrls = comp.imageDetails.finalUrls;

            importQueueEntries.push({
              id: `imp-sandbox-${Math.floor(Math.random() * 100000)}`,
              supplierCode: inbound.supplierItemCode || '',
              supplierName,
              productName: inbound.name,
              source: 'Website',
              importStatus: 'Pending',
              progress: 0,
              totalImages: comp.imageDetails.addedUrls.length,
              downloadedImages: 0,
              createdAt: timestamp
            });
          } else if (comp.changeType === 'DESCRIPTION_CHANGED') {
            descriptionChangesCount++;
            updates.name = inbound.name;
            updates.description = inbound.description;
          }
        }

        productsToUpdate.push({ id: existing.id, updates });

        const changeType = comp?.changeType || 'DESCRIPTION_CHANGED';
        let oldValueText = '';
        let newValueText = '';

        if (changeType === 'PRICE_CHANGED' && comp?.priceDetails) {
          oldValueText = `Cost: LKR ${comp.priceDetails.oldCostPrice}, Retail: LKR ${comp.priceDetails.oldPrice}`;
          newValueText = `Cost: LKR ${comp.priceDetails.newCostPrice}, Retail: LKR ${comp.priceDetails.newPrice}`;
        } else if (changeType === 'STOCK_CHANGED' && comp?.stockDetails) {
          oldValueText = `Stock: ${comp.stockDetails.oldStock}`;
          newValueText = `Stock: ${comp.stockDetails.newStock}`;
        } else if (changeType === 'IMAGE_CHANGED' && comp?.imageDetails) {
          oldValueText = `${existing.imageUrls?.length || 0} images`;
          newValueText = `${comp.imageDetails.finalUrls.length} images`;
        } else {
          oldValueText = existing.name;
          newValueText = inbound.name;
        }

        reviewQueueItems.push({
          id: revId,
          supplierCode: supplierId.toUpperCase(),
          supplierName,
          productName: inbound.name,
          source: 'Website',
          changeType: changeType as any,
          oldValue: oldValueText,
          newValue: newValueText,
          status: 'Pending',
          createdAt: timestamp
        });

        pendingChangesItems.push({
          id: revId,
          supplierCode: supplierId.toUpperCase(),
          productName: inbound.name,
          changeType,
          status: 'Pending',
          createdAt: timestamp,
          payload: {
            oldValue: oldValueText,
            newValue: newValueText
          }
        });
      }
    }

    const totalProcessed = previews.length;
    const failedCount = previews.filter(p => p.action === 'ERROR').length;
    const pendingReviews = newProductsCount + priceChangesCount + stockChangesCount + imageChangesCount + descriptionChangesCount;

    // Prepare Sync History Entry
    const syncHistoryEntry: SyncHistoryEntry = {
      id: `hist-sandbox-${Math.floor(Math.random() * 100000)}`,
      supplierId,
      supplierName,
      timestamp,
      status: failedCount > 0 && failedCount === totalProcessed ? 'failed' : 'success',
      error: failedCount === totalProcessed ? 'All sandbox items failed' : 'None',
      newProducts: newProductsCount,
      priceChanges: priceChangesCount,
      stockChanges: stockChangesCount,
      imageChanges: imageChangesCount,
      pendingReviews,
      triggeredBy,
      durationMs: 0, // Sandbox dry run execution is instant
      processedCount: totalProcessed
    };

    const approvalPayload: SandboxApprovalPayload = {
      sessionId,
      supplierId,
      supplierName,
      timestamp,
      productsToCreate,
      productsToUpdate,
      reviewQueueItems,
      pendingChangesItems,
      importQueueEntries,
      syncHistoryEntry
    };

    const rollbackPayload: SandboxRollbackPayload = {
      sessionId,
      supplierId,
      timestamp,
      originalProducts,
      createdProductIds
    };

    return {
      approvalPayload,
      rollbackPayload
    };
  }
}
export { SandboxImporter as SandboxImporterService };
