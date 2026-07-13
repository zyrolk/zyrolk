export const A2Z_PRODUCT_IMAGE_FALLBACK = 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=600';

const A2Z_IMAGE_FIELDS = [
  'mediaGallery',
  'images',
  'imageUrls',
  'productImages',
  'pro_img',
  'pro_image',
  'image',
  'image_url',
  'imageUrl',
  'img',
  'photo',
  'product_image',
  'productImage',
] as const;

function flattenImageValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenImageValues);

  if (value && typeof value === 'object') {
    const imageObject = value as Record<string, unknown>;
    return ['url', 'src', 'path', 'image', 'imageUrl'].flatMap((key) => flattenImageValues(imageObject[key]));
  }

  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return flattenImageValues(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  return trimmed.includes(',') ? trimmed.split(',').map((part) => part.trim()).filter(Boolean) : [trimmed];
}

export function normalizeA2ZImageUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed || /^(?:data|blob|javascript):/i.test(trimmed)) return null;

  try {
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    return new URL(trimmed, `${new URL(baseUrl).origin}/`).toString();
  } catch {
    return null;
  }
}

export function extractA2ZProductImages(rawObj: Record<string, any>, baseUrl: string): string[] {
  const knownFields = new Set<string>(A2Z_IMAGE_FIELDS);
  const imageLikeFields = Object.keys(rawObj).filter((field) => (
    !knownFields.has(field) && /(?:image|img|photo|picture|thumb|pic)/i.test(field)
  ));
  const images = [...A2Z_IMAGE_FIELDS, ...imageLikeFields]
    .flatMap((field) => flattenImageValues(rawObj[field]))
    .map((value) => normalizeA2ZImageUrl(value, baseUrl))
    .filter((value): value is string => Boolean(value));

  return [...new Set(images)];
}
