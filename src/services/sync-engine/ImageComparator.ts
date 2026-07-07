import { ImageComparisonResult } from './types';

export class ImageComparator {
  /**
   * Compares the current local image URLs with the incoming supplier image URLs.
   * Detects new images that need to be queued for download and obsolete images.
   * 
   * @param currentUrls Array of current local image URLs
   * @param inboundUrls Array of newly scraped/received supplier image URLs
   * @param limit Maximum number of images allowed per product (from config)
   */
  public static compare(
    currentUrls: string[] | undefined,
    inboundUrls: string[],
    limit: number = 5
  ): ImageComparisonResult {
    const localUrls = currentUrls || [];
    
    // Apply limit to inbound urls to respect disk/quota constraints
    const cappedInboundUrls = inboundUrls.slice(0, limit);

    // Normalize URLs to avoid mismatch due to trailing slashes or protocol differences
    const normalize = (url: string) => url.trim().toLowerCase().replace(/^https?:\/\//, '');

    const localNormalized = new Set(localUrls.map(normalize));
    const inboundNormalized = new Set(cappedInboundUrls.map(normalize));

    // Find added images (present in inbound, missing in local)
    const addedUrls = cappedInboundUrls.filter(url => !localNormalized.has(normalize(url)));

    // Find removed images (present in local, missing in inbound)
    const removedUrls = localUrls.filter(url => !inboundNormalized.has(normalize(url)));

    // Check if anything actually changed
    // Wait, even if the sets are same, check if order changed or if count is different
    const isSameLength = localUrls.length === cappedInboundUrls.length;
    let orderChanged = false;
    if (isSameLength) {
      for (let i = 0; i < localUrls.length; i++) {
        if (normalize(localUrls[i]) !== normalize(cappedInboundUrls[i])) {
          orderChanged = true;
          break;
        }
      }
    }

    const hasChanged = addedUrls.length > 0 || removedUrls.length > 0 || orderChanged;

    return {
      hasChanged,
      addedUrls,
      removedUrls,
      finalUrls: cappedInboundUrls
    };
  }
}
