import { ImageMetadata, ImageManagementSettings } from './types';

export interface OptimizationTask {
  id: string;
  originalUrl: string;
  targetQuality: 'original' | 'optimized';
  width?: number;
  height?: number;
  label: 'thumbnail' | 'medium' | 'original';
}

export class ImageOptimizer {
  /**
   * Prepares optimization plans for an image according to configured settings.
   * This prepares the instructions for future processes to optimize, generate thumbnails, or resize images.
   */
  public static async prepareOptimizationTasks(
    image: ImageMetadata,
    settings: ImageManagementSettings
  ): Promise<OptimizationTask[]> {
    const tasks: OptimizationTask[] = [];

    // 1. Original Image task
    if (settings.downloadOriginalImages) {
      tasks.push({
        id: `${image.id}-original`,
        originalUrl: image.originalUrl,
        targetQuality: 'original',
        label: 'original',
      });
    }

    // 2. Thumbnail Generation task (future 300px preview)
    if (settings.generateThumbnails) {
      tasks.push({
        id: `${image.id}-thumbnail`,
        originalUrl: image.originalUrl,
        targetQuality: 'optimized',
        width: 300,
        height: 300,
        label: 'thumbnail',
      });
    }

    // 3. Medium Image task (future 800px product page image)
    if (settings.generateMediumImages) {
      tasks.push({
        id: `${image.id}-medium`,
        originalUrl: image.originalUrl,
        targetQuality: 'optimized',
        width: 800,
        height: 800,
        label: 'medium',
      });
    }

    return tasks;
  }

  /**
   * Helper to construct simulated optimized paths for metadata mapping (for future storage storage hooks).
   */
  public static async mapToStorageUrls(
    image: ImageMetadata,
    bucketName: string = 'zyro-images'
  ): Promise<ImageMetadata> {
    const filename = image.originalUrl.substring(image.originalUrl.lastIndexOf('/') + 1) || 'image.jpg';
    const cleanFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');

    return {
      ...image,
      thumbnailUrl: `https://storage.googleapis.com/${bucketName}/thumbnails/${cleanFilename}`,
      mediumUrl: `https://storage.googleapis.com/${bucketName}/medium/${cleanFilename}`,
    };
  }
}
