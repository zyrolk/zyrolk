import { Product } from '../../types';
import { InboundProduct, SyncConfig } from '../sync-engine/types';
import { SandboxProductPreview } from './SandboxTypes';
import { ProductComparator } from '../sync-engine/ProductComparator';

export class SandboxComparator {
  /**
   * Evaluates inbound sandbox products against the current in-memory catalog
   * to categorize actions, detect anomalies (duplicates, missing fields, invalid images),
   * and produce preview representations.
   */
  public static async analyzeSandboxBatch(
    inboundItems: InboundProduct[],
    existingProducts: Product[],
    config: SyncConfig
  ): Promise<{
    previews: SandboxProductPreview[];
    duplicateSkuCodes: string[];
    missingRequiredFieldsSkuCodes: string[];
    invalidImagesSkuCodes: string[];
  }> {
    const previews: SandboxProductPreview[] = [];
    const duplicateSkuCodes: string[] = [];
    const missingRequiredFieldsSkuCodes: string[] = [];
    const invalidImagesSkuCodes: string[] = [];

    // Track SKU occurrences to identify duplicate supplier codes in the incoming batch
    const skuOccurrences = new Map<string, number>();
    inboundItems.forEach(item => {
      const sku = (item.supplierItemCode || '').trim().toLowerCase();
      if (sku) {
        skuOccurrences.set(sku, (skuOccurrences.get(sku) || 0) + 1);
      }
    });

    // Populate duplicate lists
    skuOccurrences.forEach((count, sku) => {
      if (count > 1) {
        duplicateSkuCodes.push(sku);
      }
    });

    // Index existing catalog by SKU for O(1) matching
    const existingMap = new Map<string, Product>();
    existingProducts.forEach(p => {
      if (p.supplierItemCode) {
        existingMap.set(p.supplierItemCode.trim().toLowerCase(), p);
      }
    });

    for (const inbound of inboundItems) {
      const skuNorm = (inbound.supplierItemCode || '').trim().toLowerCase();
      const existing = existingMap.get(skuNorm);

      const validationErrors: string[] = [];
      const reasons: string[] = [];
      
      // 1. Check Missing Required Fields
      let hasMissingRequiredFields = false;
      if (!inbound.supplierItemCode) {
        validationErrors.push('Missing Supplier Item Code (SKU).');
        hasMissingRequiredFields = true;
      }
      if (!inbound.name) {
        validationErrors.push('Missing Product Name.');
        hasMissingRequiredFields = true;
      }
      if (inbound.costPrice <= 0) {
        validationErrors.push('Cost Price must be greater than zero.');
        hasMissingRequiredFields = true;
      }

      if (hasMissingRequiredFields) {
        missingRequiredFieldsSkuCodes.push(inbound.supplierItemCode || 'MISSING_SKU');
      }

      // 2. Check Invalid Images
      let hasInvalidImages = false;
      if (inbound.imageUrls && inbound.imageUrls.length > 0) {
        for (const url of inbound.imageUrls) {
          if (!url) {
            hasInvalidImages = true;
            validationErrors.push('Contains an empty image URL.');
            break;
          }
          const lowerUrl = url.toLowerCase();
          const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];
          const hasValidExtension = validExtensions.some(ext => lowerUrl.includes(ext) || lowerUrl.startsWith('data:image/'));
          if (!hasValidExtension) {
            hasInvalidImages = true;
            validationErrors.push(`Invalid image URL format or extension: ${url}`);
            break;
          }
        }
      }

      if (hasInvalidImages) {
        invalidImagesSkuCodes.push(inbound.supplierItemCode || 'INVALID_IMAGE_SKU');
      }

      const isDuplicate = duplicateSkuCodes.includes(skuNorm);

      // 3. Determine Action and Comparison
      let action: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR' = 'SKIP';
      let comparisonResult;

      if (hasMissingRequiredFields) {
        action = 'ERROR';
        reasons.push('Validation failed: Missing required fields.');
      } else {
        // Run against existing comparator
        comparisonResult = ProductComparator.compare(existing, inbound, config);

        if (!existing) {
          action = 'CREATE';
          reasons.push('New product found. Ready to be created.');
        } else if (comparisonResult.hasChanges) {
          action = 'UPDATE';
          reasons.push(`Updates detected: ${comparisonResult.changeType}.`);
        } else {
          action = 'SKIP';
          reasons.push('No fluctuations detected. Identical to existing catalog.');
        }
      }

      previews.push({
        sku: inbound.supplierItemCode || 'UNKNOWN',
        name: inbound.name || 'Unnamed Product',
        action,
        reasons,
        comparison: comparisonResult,
        validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        isDuplicate,
        hasMissingRequiredFields,
        hasInvalidImages,
        mappedInbound: inbound,
      });
    }

    return {
      previews,
      duplicateSkuCodes,
      missingRequiredFieldsSkuCodes,
      invalidImagesSkuCodes,
    };
  }
}
