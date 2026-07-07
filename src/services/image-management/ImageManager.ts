import { ImageMetadata, ImageManagementSettings, DownloadQueuePayload } from './types';
import { ImageMetadata as ImageMetadataService } from './ImageMetadata';
import { ImageValidator } from './ImageValidator';
import { ImageOptimizer, OptimizationTask } from './ImageOptimizer';
import { ImageSelector } from './ImageSelector';
import { ImageQueueBuilder } from './ImageQueueBuilder';

export interface ProcessedImagesResult {
  success: boolean;
  mainImage: ImageMetadata | null;
  galleryImages: ImageMetadata[];
  downloadPayloads: DownloadQueuePayload[];
  optimizationTasks: OptimizationTask[];
  errors: string[];
  rejectedImages: { url: string; reason: string }[];
}

export class ImageManager {
  /**
   * Orchestrates the entire Image Management Pipeline for a product's images:
   * 1. Constructs initial metadata structures.
   * 2. Validates each image format and file size.
   * 3. Validates the collection (deduplicates & respects limits).
   * 4. Selects Main vs Gallery images according to rules.
   * 5. Prepares structural optimization tasks.
   * 6. Prepares structural download queue payloads.
   */
  public static async orchestrateImagePipeline(
    sku: string,
    imageUrls: string[],
    settings: ImageManagementSettings,
    imageSizes?: { [url: string]: number } // Simulated file sizes in bytes
  ): Promise<ProcessedImagesResult> {
    const errors: string[] = [];
    const rejectedImages: { url: string; reason: string }[] = [];
    const initialMetadataList: ImageMetadata[] = [];

    // Step 1: Create metadata & validate basic parameters
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const fileSize = imageSizes ? imageSizes[url] : undefined;

      // Basic single image validation
      const singleValidation = await ImageValidator.validateImage(url, fileSize, settings);
      if (!singleValidation.isValid) {
        rejectedImages.push({
          url,
          reason: singleValidation.errors.join(' | '),
        });
        continue;
      }

      const meta = await ImageMetadataService.createMetadata({
        originalUrl: url,
        isMain: i === 0, // Initial default
        sortOrder: i,
        size: fileSize,
      });

      initialMetadataList.push(meta);
    }

    // Step 2: Validate collection (limits, duplicate URLs/hashes)
    const collectionValidation = await ImageValidator.validateCollection(initialMetadataList, settings);
    collectionValidation.rejectedImages.forEach(rej => {
      rejectedImages.push({
        url: rej.url,
        reason: rej.reason,
      });
    });

    const activeCollection = collectionValidation.validatedCollection;

    if (activeCollection.length === 0) {
      return {
        success: false,
        mainImage: null,
        galleryImages: [],
        downloadPayloads: [],
        optimizationTasks: [],
        errors: ['No valid images remained after validation and filtering.'],
        rejectedImages,
      };
    }

    // Step 3: Automatically partition into Main & Gallery
    const { mainImage, galleryImages } = await ImageSelector.partitionImages(activeCollection, settings);

    // Recombine for optimization tasks & download queues
    const finalOrderedCollection: ImageMetadata[] = [];
    if (mainImage) finalOrderedCollection.push(mainImage);
    finalOrderedCollection.push(...galleryImages);

    // Step 4: Prepare Optimization Tasks
    const optimizationTasks: OptimizationTask[] = [];
    for (const img of finalOrderedCollection) {
      const tasks = await ImageOptimizer.prepareOptimizationTasks(img, settings);
      optimizationTasks.push(...tasks);
    }

    // Step 5: Prepare structural download payloads
    const downloadPayloads = await ImageQueueBuilder.prepareDownloadQueue(sku, finalOrderedCollection);

    return {
      success: true,
      mainImage,
      galleryImages,
      downloadPayloads,
      optimizationTasks,
      errors,
      rejectedImages,
    };
  }
}
export { ImageManager as ImageManagerService };
