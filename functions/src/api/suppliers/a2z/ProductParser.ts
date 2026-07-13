import { RawA2ZProduct } from "./types";

const BLOCKED_SUPPLIER_IMAGE_HOSTS = new Set([
  "images.unsplash.com",
  "source.unsplash.com",
  "via.placeholder.com",
  "placehold.co",
  "placeholder.com",
]);

const A2Z_PRODUCT_IMAGE_ORIGIN = "https://ayp.lk";

const A2Z_IMAGE_FIELDS = [
  "mediaGallery",
  "images",
  "imageUrls",
  "productImages",
  "pro_img",
  "pro_image",
  "image",
  "image_url",
  "imageUrl",
  "img",
  "photo",
  "product_image",
  "productImage",
] as const;

function flattenImageValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenImageValues);
  }

  if (value && typeof value === "object") {
    const imageObject = value as Record<string, unknown>;
    return ["url", "src", "path", "file", "filename", "image", "imageUrl", "original", "large", "thumbnail", "main"]
      .flatMap((key) => flattenImageValues(imageObject[key]));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim().replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  if (!trimmed) {
    return [];
  }

  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return flattenImageValues(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  const htmlSources = [...trimmed.matchAll(/(?:src|data-src)=["']([^"']+)["']/gi)].map((match) => match[1]);
  if (htmlSources.length > 0) {
    return htmlSources;
  }

  return trimmed.includes(",") ? trimmed.split(",").map((part) => part.trim()).filter(Boolean) : [trimmed];
}

export function normalizeA2ZImageUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/&amp;/gi, "&");
  if (!trimmed || /^(?:data|blob|javascript):/i.test(trimmed)) {
    return null;
  }

  try {
    const normalized = trimmed.startsWith("//")
      ? new URL(`https:${trimmed}`)
      : new URL(trimmed, `${new URL(baseUrl).origin}/`);
    return isValidSupplierImageUrl(normalized.toString()) ? normalized.toString() : null;
  } catch {
    return null;
  }
}

export function isValidSupplierImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value.trim());
    const isKnownInvalidPath = /^\/(?:0|null|undefined)?\/?$/i.test(parsed.pathname);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !isKnownInvalidPath
      && !BLOCKED_SUPPLIER_IMAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function buildA2ZProductImageUrl(productId: unknown): string | null {
  const normalizedId = String(productId ?? "").trim();
  if (!/^\d+$/.test(normalizedId) || normalizedId === "0") {
    return null;
  }
  return `${A2Z_PRODUCT_IMAGE_ORIGIN}/storage/products/a2z/${normalizedId}.jpg`;
}

export function extractA2ZProductImages(rawObj: Record<string, any>, baseUrl: string): string[] {
  const knownFields = new Set<string>(A2Z_IMAGE_FIELDS);
  const imageLikeFields = Object.keys(rawObj).filter((field) => (
    !knownFields.has(field) && /(?:^|_)(?:images?|img|photo|picture|thumbnail|thumb|pic)(?:$|_)/i.test(field)
  ));
  const images = [...A2Z_IMAGE_FIELDS, ...imageLikeFields]
    .flatMap((field) => flattenImageValues(rawObj[field]))
    .map((value) => normalizeA2ZImageUrl(value, baseUrl))
    .filter((value): value is string => Boolean(value));

  return [...new Set(images)];
}

export class ProductParser {
  public static parseJsonPayload(rawPayload: string | Record<string, any>, baseUrl = "https://a2zdropshipping.lk"): RawA2ZProduct {
    let rawObj: Record<string, any>;

    if (typeof rawPayload === "string") {
      try {
        rawObj = JSON.parse(rawPayload);
      } catch (error) {
        console.warn("[A2Z-Connector] Failed to parse raw JSON feed string.", error);
        throw new Error("Invalid JSON format for product payload ingestion.");
      }
    } else {
      rawObj = rawPayload;
    }

    const sku = String(rawObj.pro_code || rawObj.sku || rawObj.supplier_code || rawObj.pro_id || rawObj.id || "").trim();
    const title = String(rawObj.pro_name || rawObj.title || rawObj.name || rawObj.product_name || "").trim();
    const longDescription = String(rawObj.pro_desc || rawObj.longDescription || rawObj.description || rawObj.details || "").trim();

    const extractedImages = extractA2ZProductImages(rawObj, baseUrl);
    const canonicalImage = buildA2ZProductImageUrl(rawObj.pro_id);
    const mediaGallery = [...new Set([
      ...extractedImages,
      ...(canonicalImage ? [canonicalImage] : []),
    ])];

    const wholesalePrice = Number(rawObj.wholesale_price || rawObj.wholesalePrice || rawObj.costPrice || rawObj.cost_price || rawObj.supplier_price || 0);
    const recommendedRetailPrice = Number(rawObj.website_price || rawObj.price_min || rawObj.price_max || rawObj.recommendedRetailPrice || rawObj.marketPrice || rawObj.retail_price || rawObj.selling_price || 0);
    const inventoryLevel = Number(rawObj.bal !== undefined && rawObj.bal !== null ? rawObj.bal : (rawObj.inventoryLevel !== undefined ? rawObj.inventoryLevel : (rawObj.stock || rawObj.quantity || 0)));
    const categoryHierarchy = rawObj.cat_name ? [String(rawObj.cat_name)] : (Array.isArray(rawObj.categoryHierarchy) ? rawObj.categoryHierarchy.map(String) : []);
    const specifications = typeof rawObj.specifications === "object" && rawObj.specifications !== null ? rawObj.specifications : {};

    return {
      sku,
      title,
      longDescription,
      mediaGallery,
      wholesalePrice,
      recommendedRetailPrice,
      inventoryLevel,
      categoryHierarchy,
      specifications
    };
  }
}
