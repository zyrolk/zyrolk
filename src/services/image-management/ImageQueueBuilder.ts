import { ImageMetadata, DownloadQueuePayload } from './types';

export class ImageQueueBuilder {
  /**
   * Prepares structural download queue payloads for a given SKU and source URL list.
   * Does NOT run any async fetch or storage commands.
   */
  public static async prepareDownloadQueue(
    sku: string,
    images: ImageMetadata[]
  ): Promise<DownloadQueuePayload[]> {
    return images.map((img, index) => {
      const extension = img.originalUrl.substring(img.originalUrl.lastIndexOf('.')) || '.jpg';
      const cleanSku = sku.replace(/[^a-zA-Z0-9-]/g, '_');
      const targetFilename = `${cleanSku}_img_${index}${extension}`;

      return {
        id: `queue-item-${sku}-${index}-${Date.now()}`,
        sourceUrl: img.originalUrl,
        targetFilename,
        targetPath: `suppliers/${cleanSku}/${targetFilename}`,
        isMain: img.isMain,
        sortOrder: img.sortOrder,
        expectedWidth: img.width,
        expectedHeight: img.height,
      };
    });
  }

  /**
   * Map metadata list to the format expected by the existing Sync Engine or Import Queue.
   * Ensures output conforms to Sync Pipeline standards.
   */
  public static async mapToSyncEngine(
    images: ImageMetadata[]
  ): Promise<{
    imageUrls: string[];
    mainImage?: string;
    galleryImages?: string[];
  }> {
    const sorted = [...images].sort((a, b) => a.sortOrder - b.sortOrder);
    const mainImg = sorted.find(img => img.isMain) || sorted[0];

    return {
      imageUrls: sorted.map(img => img.originalUrl),
      mainImage: mainImg?.originalUrl,
      galleryImages: sorted.filter(img => !img.isMain).map(img => img.originalUrl),
    };
  }
}
export { ImageQueueBuilder as ImageQueueBuilderService };
