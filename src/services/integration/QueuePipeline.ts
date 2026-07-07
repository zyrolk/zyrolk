import { ImageDownloader, DownloadRequest } from '../connectors/a2z-website/ImageDownloader';
import { ImportQueueEntry } from '../sync-engine/types';

export class QueuePipeline {
  /**
   * Translates incoming image lists into structured download requests for a given SKU.
   * This is a pure logic operation.
   */
  public static async prepareDownloads(
    sku: string,
    imageUrls: string[]
  ): Promise<DownloadRequest[]> {
    return ImageDownloader.prepareDownloadQueue(sku, imageUrls);
  }

  /**
   * Prepares the payload for creating a new download/import queue entry in Firestore.
   * Exposes structural representation only; does not write to the database.
   */
  public static async prepareQueueEntryPayload(
    sku: string,
    supplierName: string,
    productName: string,
    source: 'Website' | 'WhatsApp',
    totalImages: number
  ): Promise<ImportQueueEntry> {
    const id = `imp-payload-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const nowIso = new Date().toISOString();

    return {
      id,
      supplierCode: sku,
      supplierName,
      productName,
      source,
      importStatus: 'Pending',
      progress: 0,
      totalImages,
      downloadedImages: 0,
      createdAt: nowIso
    };
  }

  /**
   * Prepares the update payload to mark active imports as progressing.
   */
  public static async prepareProgressUpdatePayload(
    id: string,
    downloadedImages: number,
    totalImages: number
  ): Promise<{
    id: string;
    progress: number;
    downloadedImages: number;
    importStatus: 'Downloading';
  }> {
    const progress = totalImages > 0 ? Math.round((downloadedImages / totalImages) * 100) : 100;
    return {
      id,
      progress,
      downloadedImages,
      importStatus: 'Downloading'
    };
  }

  /**
   * Prepares the update payload to mark a queue entry as successfully completed.
   */
  public static async prepareCompletedPayload(id: string): Promise<{
    id: string;
    importStatus: 'Completed';
    progress: number;
    completedAt: string;
  }> {
    return {
      id,
      importStatus: 'Completed',
      progress: 100,
      completedAt: new Date().toISOString()
    };
  }

  /**
   * Prepares the update payload to mark a queue entry as failed.
   */
  public static async prepareFailedPayload(
    id: string,
    errorMessage: string
  ): Promise<{
    id: string;
    importStatus: 'Failed';
    completedAt: string;
    errorMessage: string;
  }> {
    return {
      id,
      importStatus: 'Failed',
      completedAt: new Date().toISOString(),
      errorMessage
    };
  }
}
