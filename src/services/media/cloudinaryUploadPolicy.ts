export const CLOUDINARY_UPLOAD_ORIGIN = 'https://api.cloudinary.com';
export const CLOUDINARY_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const CLOUDINARY_ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface CloudinaryUploadCandidate {
  type: string;
  size: number;
}

export function validateCloudinaryUploadCandidate(file: CloudinaryUploadCandidate): string | null {
  if (!CLOUDINARY_ALLOWED_IMAGE_TYPES.has(file.type.trim().toLowerCase())) {
    return 'Select a PNG, JPG, JPEG, or WEBP image.';
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return 'The selected image is empty or invalid.';
  }
  if (file.size > CLOUDINARY_MAX_IMAGE_BYTES) {
    return 'The selected image exceeds the 10MB limit.';
  }
  return null;
}

const boundedCloudinaryIdentifier = /^[A-Za-z0-9_-]{1,100}$/u;

export function buildCloudinaryImageUploadUrl(cloudName: string): string {
  const normalizedCloudName = cloudName.trim();
  if (!boundedCloudinaryIdentifier.test(normalizedCloudName)) {
    throw new Error('Cloudinary cloud name is invalid.');
  }
  return `${CLOUDINARY_UPLOAD_ORIGIN}/v1_1/${normalizedCloudName}/image/upload`;
}

export function validateCloudinaryUploadPreset(uploadPreset: string): string {
  const normalizedPreset = uploadPreset.trim();
  if (!boundedCloudinaryIdentifier.test(normalizedPreset)) {
    throw new Error('Cloudinary upload preset is invalid.');
  }
  return normalizedPreset;
}
