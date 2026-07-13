import { RawA2ZProduct } from "./types";

export const A2Z_PRODUCT_IMAGE_FALLBACK = "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=600";

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
    return ["url", "src", "path", "image", "imageUrl"].flatMap((key) => flattenImageValues(imageObject[key]));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return flattenImageValues(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  return trimmed.includes(",") ? trimmed.split(",").map((part) => part.trim()).filter(Boolean) : [trimmed];
}

export function normalizeA2ZImageUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed || /^(?:data|blob|javascript):/i.test(trimmed)) {
    return null;
  }

  try {
    if (trimmed.startsWith("//")) {
      return `https:${trimmed}`;
    }
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
    const mediaGallery = extractedImages.length > 0 ? extractedImages : [A2Z_PRODUCT_IMAGE_FALLBACK];

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
