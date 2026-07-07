import { ImageMetadata, ImageManagementSettings } from './types';

export class ImageSelector {
  /**
   * Distributes supplier images into Main Image and Gallery Images.
   * By default, automatically sets the first image (sortOrder === 0) as isMain.
   * Maintains overall order.
   */
  public static async partitionImages(
    images: ImageMetadata[],
    settings: ImageManagementSettings
  ): Promise<{
    mainImage: ImageMetadata | null;
    galleryImages: ImageMetadata[];
  }> {
    if (images.length === 0) {
      return { mainImage: null, galleryImages: [] };
    }

    // Sort by sortOrder first to ensure first element is consistent
    const sortedImages = [...images].sort((a, b) => a.sortOrder - b.sortOrder);

    let mainImage: ImageMetadata | null = null;
    const galleryImages: ImageMetadata[] = [];

    if (settings.autoSelectFirstImage) {
      // Set first as main, remainder as gallery
      sortedImages.forEach((img, index) => {
        if (index === 0) {
          mainImage = { ...img, isMain: true, sortOrder: 0 };
        } else {
          galleryImages.push({ ...img, isMain: false, sortOrder: index });
        }
      });
    } else {
      // Find the one already marked as isMain, otherwise default to first if none
      const markedMainIndex = sortedImages.findIndex(img => img.isMain);
      const finalMainIndex = markedMainIndex !== -1 ? markedMainIndex : 0;

      sortedImages.forEach((img, index) => {
        const isSelectedMain = index === finalMainIndex;
        if (isSelectedMain) {
          mainImage = { ...img, isMain: true, sortOrder: 0 };
        } else {
          galleryImages.push({ ...img, isMain: false, sortOrder: galleryImages.length + 1 });
        }
      });
    }

    return { mainImage, galleryImages };
  }

  /**
   * Overrides the current selection with a user-specified manual selection.
   * Simulates future user action in the Supplier Hub.
   */
  public static async selectManualMainImage(
    images: ImageMetadata[],
    selectedId: string
  ): Promise<{
    mainImage: ImageMetadata | null;
    galleryImages: ImageMetadata[];
  }> {
    const updated = images.map(img => ({
      ...img,
      isMain: img.id === selectedId,
    }));

    // Re-partition using updated attributes
    return this.partitionImages(updated, {
      autoSelectFirstImage: false,
      maxImages: 100,
      downloadOriginalImages: true,
      generateThumbnails: true,
      generateMediumImages: true,
      skipLargeImages: false,
      maxFileSizeMB: 10,
      removeDuplicateImages: true,
    });
  }
}
export { ImageSelector as ImageSelectorService };
