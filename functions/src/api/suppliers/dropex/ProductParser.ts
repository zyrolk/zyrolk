import { RawA2ZProduct } from "../a2z/types";
import { DROPEX_IMAGE_BASE_URL } from "./constants";

const BLOCKED_SUPPLIER_IMAGE_HOSTS = new Set([
  "images.unsplash.com",
  "source.unsplash.com",
  "via.placeholder.com",
  "placehold.co",
  "placeholder.com",
]);

export interface DropexCategoryLookup {
  resolveCategory(value: unknown): { category?: string; subcategory?: string; hierarchy?: string[] };
}

const optionalRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
};

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
};

export function buildDropexProductImageUrl(filename: string): string | null {
  const normalized = String(filename || "").trim().replace(/\\/g, "/");
  if (!normalized || /^(?:data|blob|javascript):/i.test(normalized)) return null;
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      const parsed = new URL(normalized);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password
        ? parsed.toString()
        : null;
    } catch {
      return null;
    }
  }
  const cleanFilename = normalized.replace(/^\/+/, "").split("/").pop() || "";
  if (!cleanFilename) return null;
  return `${DROPEX_IMAGE_BASE_URL}/${encodeURIComponent(cleanFilename).replace(/%2F/g, "/")}`;
}

export function extractDropexProductImages(imageValue: unknown): string[] {
  const filenames = typeof imageValue === "string"
    ? imageValue.split(",").map((entry) => entry.trim()).filter(Boolean)
    : Array.isArray(imageValue)
      ? imageValue.flatMap((entry) => extractDropexProductImages(entry))
      : [];
  const urls = filenames
    .map((filename) => buildDropexProductImageUrl(filename))
    .filter((url): url is string => Boolean(url))
    .filter((url) => {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        return !BLOCKED_SUPPLIER_IMAGE_HOSTS.has(hostname);
      } catch {
        return false;
      }
    });
  return [...new Set(urls)];
}

function readProductDetail(item: Record<string, unknown>): Record<string, unknown> {
  return optionalRecord(item.productDetail) || item;
}

function readCategoryLabels(
  detail: Record<string, unknown>,
  item: Record<string, unknown>,
  lookup?: DropexCategoryLookup,
): { supplierCategory?: string; supplierSubcategory?: string; categoryHierarchy?: string[] } {
  const directCategory = optionalString(detail.categoryName)
    || optionalString(detail.category)
    || optionalString(item.categoryName)
    || optionalString(item.category);
  const directSubcategory = optionalString(detail.subCategoryName)
    || optionalString(detail.subCategory)
    || optionalString(detail.subcategory)
    || optionalString(item.subCategoryName)
    || optionalString(item.subCategory);

  const categoryRecord = optionalRecord(detail.productCategory)
    || optionalRecord(detail.category)
    || optionalRecord(item.productCategory)
    || optionalRecord(item.category);
  const categoryFromRecord = optionalString(categoryRecord?.name) || optionalString(categoryRecord?.label);
  const subcategoryRecord = optionalRecord(detail.productSubCategory)
    || optionalRecord(detail.subCategory)
    || optionalRecord(item.productSubCategory);
  const subcategoryFromRecord = optionalString(subcategoryRecord?.name) || optionalString(subcategoryRecord?.label);

  const lookupKey = detail.productCategoryId
    ?? detail.categoryId
    ?? item.productCategoryId
    ?? item.categoryId;
  const resolved = lookup?.resolveCategory(lookupKey);

  const supplierCategory = directCategory || categoryFromRecord || resolved?.category;
  const supplierSubcategory = directSubcategory || subcategoryFromRecord || resolved?.subcategory;
  const categoryHierarchy = resolved?.hierarchy
    || [supplierCategory, supplierSubcategory].filter((entry): entry is string => Boolean(entry));

  return {
    ...(supplierCategory ? { supplierCategory } : {}),
    ...(supplierSubcategory ? { supplierSubcategory } : {}),
    ...(categoryHierarchy.length > 0 ? { categoryHierarchy } : {}),
  };
}

export class ProductParser {
  public static parseCatalogItem(
    rawItem: Record<string, unknown>,
    options: { categoryLookup?: DropexCategoryLookup; enrichment?: Record<string, unknown> } = {},
  ): RawA2ZProduct {
    const item = { ...rawItem, ...(options.enrichment || {}) };
    const detail = readProductDetail(item);
    const supplierProductId = optionalString(detail.id) || optionalString(item.productId) || optionalString(item.id);
    const sku = optionalString(detail.sku) || optionalString(item.sku) || supplierProductId || "";
    const title = optionalString(detail.name) || optionalString(item.name) || "";
    const longDescription = optionalString(detail.description) || optionalString(item.description) || "";
    const wholesalePrice = optionalNumber(item.reSellingPrice)
      ?? optionalNumber(item.resellingPrice)
      ?? optionalNumber(item.reSellerPrice)
      ?? 0;
    const recommendedRetailPrice = optionalNumber(detail.sellingPrice)
      ?? optionalNumber(item.sellingPrice)
      ?? optionalNumber(item.marketPrice)
      ?? 0;
    const inventoryLevel = optionalNumber(detail.onHandInventory)
      ?? optionalNumber(item.onHandInventory)
      ?? optionalNumber(item.stock)
      ?? 0;
    const mediaGallery = extractDropexProductImages(detail.image ?? item.image);
    const categoryFields = readCategoryLabels(detail, item, options.categoryLookup);
    const brand = optionalString(detail.brand) || optionalString(item.brand);
    const openInventory = optionalNumber(detail.openInventory) ?? optionalNumber(item.openInventory);
    const dedicatedInventory = optionalNumber(detail.dedicatedInventory) ?? optionalNumber(item.dedicatedInventory);
    const maxOrderCount = optionalNumber(detail.maxOrderCount) ?? optionalNumber(item.maxOrderCount);

    const extraAttributes: Record<string, unknown> = {};
    if (openInventory !== undefined) extraAttributes.openInventory = openInventory;
    if (dedicatedInventory !== undefined) extraAttributes.dedicatedInventory = dedicatedInventory;
    if (maxOrderCount !== undefined) extraAttributes.maxOrderCount = maxOrderCount;

    return {
      sku,
      title,
      longDescription,
      mediaGallery,
      wholesalePrice,
      recommendedRetailPrice,
      inventoryLevel,
      ...(supplierProductId ? { supplierProductId } : {}),
      ...(brand ? { brand } : {}),
      ...categoryFields,
      ...(Object.keys(extraAttributes).length > 0 ? { extraAttributes } : {}),
      providedFields: [
        "sku",
        "title",
        "longDescription",
        "wholesalePrice",
        "recommendedRetailPrice",
        "inventoryLevel",
        ...(mediaGallery.length > 0 ? ["mediaGallery"] as const : []),
        ...(supplierProductId ? ["supplierProductId"] as const : []),
        ...(brand ? ["brand"] as const : []),
        ...(categoryFields.supplierCategory ? ["supplierCategory"] as const : []),
        ...(categoryFields.supplierSubcategory ? ["supplierSubcategory"] as const : []),
        ...(Object.keys(extraAttributes).length > 0 ? ["extraAttributes"] as const : []),
      ],
    };
  }
}
