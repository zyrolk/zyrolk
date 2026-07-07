import { ImageMetadata, ImageManagementSettings, ImageValidationResult } from './types';

export class ImageValidator {
  /**
   * Validates a single image's attributes against configurable settings.
   */
  public static async validateImage(
    url: string,
    fileSizeInBytes: number | undefined,
    settings: ImageManagementSettings
  ): Promise<ImageValidationResult> {
    const errors: string[] = [];

    // Check file size if available
    if (fileSizeInBytes !== undefined) {
      const maxSizeBytes = settings.maxFileSizeMB * 1024 * 1024;
      if (settings.skipLargeImages && fileSizeInBytes > maxSizeBytes) {
        errors.push(`Image file size (${(fileSizeInBytes / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size of ${settings.maxFileSizeMB} MB.`);
      }
    }

    // Basic extension-based/URL-based validation
    if (!url) {
      errors.push('Image URL is empty or invalid.');
    } else {
      const lowerUrl = url.toLowerCase();
      const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];
      const hasValidExtension = validExtensions.some(ext => lowerUrl.includes(ext) || lowerUrl.startsWith('data:image/'));
      if (!hasValidExtension) {
        errors.push(`Invalid image file format or protocol. Supported formats: ${validExtensions.join(', ')}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Filters out duplicates and checks overall collection size boundaries.
   */
  public static async validateCollection(
    images: ImageMetadata[],
    settings: ImageManagementSettings
  ): Promise<{
    validatedCollection: ImageMetadata[];
    rejectedImages: { id: string; url: string; reason: string }[];
  }> {
    const validatedCollection: ImageMetadata[] = [];
    const rejectedImages: { id: string; url: string; reason: string }[] = [];

    const seenUrls = new Set<string>();
    const seenHashes = new Set<string>();

    for (const img of images) {
      // 1. Max Images boundary check
      if (validatedCollection.length >= settings.maxImages) {
        rejectedImages.push({
          id: img.id,
          url: img.originalUrl,
          reason: `Exceeded maximum configurable limit of ${settings.maxImages} images.`,
        });
        continue;
      }

      // 2. Duplicate Detection (URL or Content Hash)
      if (settings.removeDuplicateImages) {
        if (seenUrls.has(img.originalUrl)) {
          rejectedImages.push({
            id: img.id,
            url: img.originalUrl,
            reason: 'Duplicate image URL detected.',
          });
          continue;
        }

        if (img.imageHash && seenHashes.has(img.imageHash)) {
          rejectedImages.push({
            id: img.id,
            url: img.originalUrl,
            reason: 'Duplicate image content hash detected.',
          });
          continue;
        }
      }

      // 3. Validation success
      seenUrls.add(img.originalUrl);
      if (img.imageHash) {
        seenHashes.add(img.imageHash);
      }
      validatedCollection.push(img);
    }

    return {
      validatedCollection,
      rejectedImages,
    };
  }
}
