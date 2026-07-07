export interface ImageMetadata {
  id: string;
  originalUrl: string;
  thumbnailUrl?: string; // 300px preview (future)
  mediumUrl?: string;    // 800px product page (future)
  imageHash?: string;    // MD5 or similar checksum for duplicate detection
  width?: number;
  height?: number;
  size?: number;          // File size in bytes
  mimeType?: string;      // e.g., 'image/jpeg', 'image/png'
  isMain: boolean;
  sortOrder: number;
}

export interface ImageManagementSettings {
  autoSelectFirstImage: boolean;
  maxImages: number;
  downloadOriginalImages: boolean;
  generateThumbnails: boolean;
  generateMediumImages: boolean;
  skipLargeImages: boolean;
  maxFileSizeMB: number; // Configurable max file size in MB
  removeDuplicateImages: boolean;
}

export interface ImageValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface DownloadQueuePayload {
  id: string;
  sourceUrl: string;
  targetFilename: string;
  targetPath: string;
  isMain: boolean;
  sortOrder: number;
  expectedWidth?: number;
  expectedHeight?: number;
}
