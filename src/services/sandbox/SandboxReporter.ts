import { SandboxPreviewReport, SandboxProductPreview, SandboxSummary } from './SandboxTypes';

export class SandboxReporter {
  /**
   * Generates a fully aggregated preview report for the UI and analytical validation dashboards.
   */
  public static generateReport(params: {
    sessionId: string;
    supplierId: string;
    supplierName: string;
    previews: SandboxProductPreview[];
    duplicateSkuCodes: string[];
    missingRequiredFieldsSkuCodes: string[];
    invalidImagesSkuCodes: string[];
  }): SandboxPreviewReport {
    const {
      sessionId,
      supplierId,
      supplierName,
      previews,
      duplicateSkuCodes,
      missingRequiredFieldsSkuCodes,
      invalidImagesSkuCodes,
    } = params;

    let newProducts = 0;
    let updates = 0;
    let skipped = 0;
    let errors = 0;
    let totalImages = 0;
    let queueSize = 0;

    previews.forEach(preview => {
      if (preview.action === 'CREATE') {
        newProducts++;
      } else if (preview.action === 'UPDATE') {
        updates++;
      } else if (preview.action === 'SKIP') {
        skipped++;
      } else if (preview.action === 'ERROR') {
        errors++;
      }

      if (preview.mappedInbound) {
        totalImages += preview.mappedInbound.imageUrls?.length || 0;
        
        // Projected queue size for image downloads (if new product or image changes detected)
        const hasImageChanges = preview.comparison?.changeType === 'IMAGE_CHANGED' || preview.comparison?.changeType === 'NEW_PRODUCT';
        if (hasImageChanges && preview.mappedInbound.imageUrls) {
          queueSize += preview.mappedInbound.imageUrls.length;
        }
      }
    });

    const summary: SandboxSummary = {
      totalProducts: previews.length,
      newProducts,
      updates,
      skipped,
      errors,
      totalImages,
      queueSize,
    };

    return {
      sessionId,
      supplierId,
      supplierName,
      timestamp: new Date().toISOString(),
      summary,
      previews,
      duplicateSkuCodes,
      missingRequiredFieldsSkuCodes,
      invalidImagesSkuCodes,
    };
  }
}
export { SandboxReporter as SandboxReporterService };
