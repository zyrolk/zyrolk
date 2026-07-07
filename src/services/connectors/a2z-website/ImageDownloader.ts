import { QueueManager } from '../../sync-engine/QueueManager';
import { ConnectorLogger } from './ConnectorLogger';

export interface DownloadRequest {
  imageUrl: string;
  targetFilename: string;
  metadata: {
    sku: string;
    index: number;
    fileExtension: string;
  };
}

export class ImageDownloader {
  /**
   * Prepares structural download requests for product images.
   * Filters invalid URLs, determines appropriate naming patterns, and registers progress markers.
   */
  public static prepareDownloadQueue(
    sku: string,
    imageUrls: string[]
  ): DownloadRequest[] {
    const validUrls = imageUrls.filter(url => {
      if (!url || url.trim() === '') return false;
      try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch (e) {
        return false;
      }
    });

    return validUrls.map((url, index) => {
      // Determine file extension
      let fileExtension = 'jpg';
      try {
        const pathSegments = new URL(url).pathname.split('/');
        const lastSegment = pathSegments[pathSegments.length - 1];
        if (lastSegment && lastSegment.includes('.')) {
          const ext = lastSegment.split('.').pop()?.toLowerCase();
          if (ext && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
            fileExtension = ext;
          }
        }
      } catch (e) {
        // fallback to jpg
      }

      const cleanSku = sku.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const targetFilename = `${cleanSku}-${index + 1}.${fileExtension}`;

      return {
        imageUrl: url,
        targetFilename,
        metadata: {
          sku,
          index,
          fileExtension
        }
      };
    });
  }

  /**
   * Enqueues downloading operations with the primary queue manager.
   */
  public static async queueDownloads(
    sku: string,
    supplierName: string,
    productName: string,
    imageUrls: string[]
  ): Promise<string | null> {
    const requests = this.prepareDownloadQueue(sku, imageUrls);
    if (requests.length === 0) {
      await ConnectorLogger.log('warn', 'ImageDownloader', 'No valid image URLs provided for queueing', { sku });
      return null;
    }

    // Register with the global import queue system
    const queueId = await QueueManager.createQueueEntry(
      sku,
      supplierName,
      productName,
      'Website',
      requests.length
    );

    await ConnectorLogger.log('info', 'ImageDownloader', 'Successfully created download queue entries', {
      sku,
      queueId,
      imageCount: requests.length
    });

    return queueId;
  }
}
