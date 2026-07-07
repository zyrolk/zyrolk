import { ImageMetadata } from './types';

export class ImageMetadataService {
  /**
   * Prepares and structures metadata for an image without executing any writes or network requests.
   */
  public static async createMetadata(params: {
    originalUrl: string;
    thumbnailUrl?: string;
    mediumUrl?: string;
    imageHash?: string;
    width?: number;
    height?: number;
    size?: number;
    mimeType?: string;
    isMain: boolean;
    sortOrder: number;
  }): Promise<ImageMetadata> {
    const id = `img-meta-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    return {
      id,
      originalUrl: params.originalUrl,
      thumbnailUrl: params.thumbnailUrl,
      mediumUrl: params.mediumUrl,
      imageHash: params.imageHash,
      width: params.width,
      height: params.height,
      size: params.size,
      mimeType: params.mimeType,
      isMain: params.isMain,
      sortOrder: params.sortOrder,
    };
  }

  /**
   * Helper to re-map sort orders for a list of metadata, preserving ordering.
   */
  public static async updateSortOrder(
    images: ImageMetadata[],
    newOrderIds: string[]
  ): Promise<ImageMetadata[]> {
    return images.map(img => {
      const index = newOrderIds.indexOf(img.id);
      if (index !== -1) {
        return {
          ...img,
          sortOrder: index,
        };
      }
      return img;
    }).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * Helper to set a specific image as the main image and demote others to gallery images.
   */
  public static async setMainImage(
    images: ImageMetadata[],
    mainImageId: string
  ): Promise<ImageMetadata[]> {
    return images.map(img => ({
      ...img,
      isMain: img.id === mainImageId,
    }));
  }
}
export { ImageMetadataService as ImageMetadata };
