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

const FIELD_ALIASES = {
  supplierProductId: ["supplierProductId", "supplier_product_id", "productId", "product_id", "pro_id", "id"],
  sku: ["sku", "pro_code", "supplier_code", "supplierSku", "supplier_sku", "product_code"],
  barcode: ["barcode", "barCode", "ean", "EAN", "upc", "UPC", "isbn", "ISBN", "gtin"],
  title: ["title", "pro_name", "name", "product_name", "productName"],
  shortDescription: ["shortDescription", "short_description", "short_desc", "summary", "excerpt"],
  longDescription: ["longDescription", "fullDescription", "full_description", "pro_desc", "description", "details"],
  brand: ["brand", "brand_name", "brandName"],
  manufacturer: ["manufacturer", "manufacturer_name", "manufacturerName", "maker"],
  model: ["model", "model_number", "modelNumber", "mpn"],
  categoryHierarchy: ["categoryHierarchy", "category_hierarchy", "categories", "breadcrumbs"],
  supplierCategory: ["supplierCategory", "supplier_category", "cat_name", "category", "category_name", "categoryName"],
  supplierSubcategory: ["supplierSubcategory", "supplier_subcategory", "sub_category", "subcategory", "subcategory_name", "subCategory"],
  tags: ["tags", "product_tags", "tag_list"],
  keywords: ["keywords", "search_keywords", "searchKeywords"],
  productType: ["productType", "product_type", "type"],
  collection: ["collection", "collection_name", "collectionName"],
  attributes: ["attributes", "product_attributes", "custom_attributes"],
  variants: ["variants", "product_variants", "variations"],
  options: ["options", "product_options", "variant_options"],
  specifications: ["specifications", "specs", "technical_specifications"],
  features: ["features", "key_features", "keyFeatures", "highlights"],
  dimensions: ["dimensions", "product_dimensions", "dimension"],
  weight: ["weight", "product_weight", "shipping_weight"],
  packageSize: ["packageSize", "package_size", "package_dimensions", "pack_size"],
  shippingClass: ["shippingClass", "shipping_class"],
  warranty: ["warranty", "warranty_period", "warrantyPeriod"],
  countryOfOrigin: ["countryOfOrigin", "country_of_origin", "origin_country", "made_in"],
  mediaGallery: A2Z_IMAGE_FIELDS,
  videoUrls: ["videoUrls", "video_urls", "videos", "video", "product_video", "video_url"],
  price: ["price", "selling_price", "sellingPrice", "website_price", "price_min"],
  comparePrice: ["comparePrice", "compare_price", "regular_price", "price_max", "recommendedRetailPrice", "marketPrice", "retail_price"],
  costPrice: ["costPrice", "cost_price", "wholesale_price", "wholesalePrice", "supplier_price", "purchase_price"],
  currency: ["currency", "currency_code", "currencyCode"],
  tax: ["tax", "tax_rate", "taxRate", "tax_class", "taxClass"],
  discount: ["discount", "discount_percent", "discountPercent", "discount_percentage"],
  stock: ["inventoryLevel", "inventory_level", "stock", "quantity", "qty", "bal"],
  availability: ["availability", "stock_status", "stockStatus"],
  leadTime: ["leadTime", "lead_time", "delivery_lead_time"],
  minimumOrderQuantity: ["minimumOrderQuantity", "minimum_order_quantity", "min_order_quantity", "moq"],
  maximumOrderQuantity: ["maximumOrderQuantity", "maximum_order_quantity", "max_order_quantity"],
  visibility: ["visibility", "visible", "is_visible"],
  status: ["status", "product_status"],
  lastUpdated: ["lastUpdated", "last_updated", "updatedAt", "updated_at", "date_modified"],
  createdDate: ["createdDate", "created_date", "createdAt", "created_at", "date_created"],
  slug: ["slug", "url_slug", "handle"],
  metaDescription: ["metaDescription", "meta_description", "seo_description"],
  extraAttributes: ["extraAttributes"],
  providedFields: ["providedFields"],
} as const;

type CanonicalSupplierField = keyof typeof FIELD_ALIASES;

const VARIANT_ATTRIBUTE_ALIASES = {
  Color: ["color", "colour"],
  Size: ["size"],
  Storage: ["storage", "storage_capacity"],
  RAM: ["ram", "memory"],
  Capacity: ["capacity"],
  Pattern: ["pattern"],
  Style: ["style"],
} as const;

const hasOwnValue = (record: Record<string, unknown>, key: string): boolean => (
  Object.hasOwn(record, key) && record[key] !== undefined && record[key] !== null
);

function firstSupplied(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    if (hasOwnValue(record, alias)) return record[alias];
  }
  return undefined;
}

function optionalString(record: Record<string, unknown>, aliases: readonly string[]): string | undefined {
  const value = firstSupplied(record, aliases);
  if (value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function optionalNumber(record: Record<string, unknown>, aliases: readonly string[]): number | undefined {
  const value = firstSupplied(record, aliases);
  if (value === undefined || (typeof value === "string" && !value.trim())) return undefined;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function stringList(value: unknown): string[] | undefined {
  const items = Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" || typeof entry === "number" ? [String(entry)] : [])
    : typeof value === "string" || typeof value === "number"
      ? String(value).split(/[,|\n]/gu)
      : [];
  const normalized = [...new Set(items.map((entry) => entry.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function categoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" || typeof entry === "number") return [String(entry).trim()];
    const record = optionalRecord(entry);
    if (!record) return [];
    const label = record.name ?? record.label ?? record.title ?? record.id;
    return label === undefined || label === null ? [] : [String(label).trim()];
  }).filter(Boolean);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = value.trim().startsWith("//") ? new URL(`https:${value.trim()}`) : new URL(value.trim(), baseUrl);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function flattenVideoValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenVideoValues);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["url", "src", "path", "file", "video", "videoUrl", "video_url"]
      .flatMap((key) => flattenVideoValues(record[key]));
  }
  if (typeof value !== "string") return [];
  return value.split(/[,|\n]/gu).map((entry) => entry.trim()).filter(Boolean);
}

function extractVideoUrls(value: unknown, baseUrl: string): string[] | undefined {
  const urls = flattenVideoValues(value)
    .map((item) => normalizeHttpUrl(item, baseUrl))
    .filter((item): item is string => Boolean(item));
  const unique = [...new Set(urls)];
  return unique.length > 0 ? unique : undefined;
}

function canonicalProvidedFields(rawObj: Record<string, unknown>): string[] {
  const inherited = stringList(firstSupplied(rawObj, FIELD_ALIASES.providedFields)) || [];
  if (Object.hasOwn(rawObj, "providedFields")) return [...new Set(inherited)];
  const detected = (Object.entries(FIELD_ALIASES) as Array<[CanonicalSupplierField, readonly string[]]>)
    .filter(([field, aliases]) => field !== "providedFields" && field !== "extraAttributes" && aliases.some((alias) => hasOwnValue(rawObj, alias)))
    .map(([field]) => field);
  if (Object.values(VARIANT_ATTRIBUTE_ALIASES).some((aliases) => aliases.some((alias) => hasOwnValue(rawObj, alias)))) {
    detected.push("attributes");
  }
  return [...new Set([...inherited, ...detected])];
}

function collectExtraAttributes(rawObj: Record<string, unknown>): Record<string, unknown> | undefined {
  const recognized = new Set<string>(Object.values(FIELD_ALIASES).flat());
  Object.values(VARIANT_ATTRIBUTE_ALIASES).flat().forEach((field) => recognized.add(field));
  A2Z_IMAGE_FIELDS.forEach((field) => recognized.add(field));
  const existing = optionalRecord(firstSupplied(rawObj, FIELD_ALIASES.extraAttributes));
  const extras: Record<string, unknown> = { ...(existing || {}) };
  for (const [key, value] of Object.entries(rawObj)) {
    const unsafeKey = ["__proto__", "prototype", "constructor"].includes(key);
    const imageLikeKey = /(?:^|_)(?:images?|img|photo|picture|thumbnail|thumb|pic)(?:$|_)/i.test(key);
    if (!unsafeKey && !recognized.has(key) && !imageLikeKey && value !== undefined) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

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

    const supplierProductId = optionalString(rawObj, FIELD_ALIASES.supplierProductId);
    const sku = optionalString(rawObj, FIELD_ALIASES.sku) || supplierProductId || "";
    const title = optionalString(rawObj, FIELD_ALIASES.title) || "";
    const longDescription = optionalString(rawObj, FIELD_ALIASES.longDescription) || "";
    const shortDescription = optionalString(rawObj, FIELD_ALIASES.shortDescription);

    const extractedImages = extractA2ZProductImages(rawObj, baseUrl);
    const canonicalImage = buildA2ZProductImageUrl(rawObj.pro_id);
    const mediaGallery = [...new Set([
      ...extractedImages,
      ...(canonicalImage ? [canonicalImage] : []),
    ])];

    const costPrice = optionalNumber(rawObj, FIELD_ALIASES.costPrice);
    const price = optionalNumber(rawObj, FIELD_ALIASES.price);
    const comparePrice = optionalNumber(rawObj, FIELD_ALIASES.comparePrice);
    const wholesalePrice = costPrice ?? 0;
    const recommendedRetailPrice = optionalNumber(rawObj, ["website_price", "price_min", "price_max", "recommendedRetailPrice", "marketPrice", "retail_price", "selling_price", "sellingPrice", "price", "comparePrice", "compare_price"]) ?? 0;
    const inventoryLevel = optionalNumber(rawObj, FIELD_ALIASES.stock) ?? 0;
    const barcode = optionalString(rawObj, FIELD_ALIASES.barcode);
    const supplierCategory = optionalString(rawObj, FIELD_ALIASES.supplierCategory);
    const supplierSubcategory = optionalString(rawObj, FIELD_ALIASES.supplierSubcategory);
    const suppliedHierarchy = firstSupplied(rawObj, FIELD_ALIASES.categoryHierarchy);
    const categoryHierarchy = Array.isArray(suppliedHierarchy)
      ? categoryList(suppliedHierarchy)
      : [supplierCategory, supplierSubcategory].filter((entry): entry is string => Boolean(entry));
    const rawSpecifications = optionalRecord(firstSupplied(rawObj, FIELD_ALIASES.specifications));
    const specifications = rawSpecifications
      ? Object.fromEntries(Object.entries(rawSpecifications).map(([key, value]) => [key, String(value ?? "")]))
      : {};
    const suppliedAttributes = optionalRecord(firstSupplied(rawObj, FIELD_ALIASES.attributes));
    const variantAttributes = Object.fromEntries(Object.entries(VARIANT_ATTRIBUTE_ALIASES)
      .map(([label, aliases]) => [label, firstSupplied(rawObj, aliases)])
      .filter(([, value]) => value !== undefined));
    const attributes = Object.keys({ ...(suppliedAttributes || {}), ...variantAttributes }).length > 0
      ? { ...(suppliedAttributes || {}), ...variantAttributes }
      : undefined;
    const rawVariants = firstSupplied(rawObj, FIELD_ALIASES.variants);
    const variants = Array.isArray(rawVariants) ? rawVariants : undefined;
    const rawOptions = firstSupplied(rawObj, FIELD_ALIASES.options);
    const options = rawOptions;
    const dimensions = firstSupplied(rawObj, FIELD_ALIASES.dimensions);
    const weight = firstSupplied(rawObj, FIELD_ALIASES.weight);
    const packageSize = firstSupplied(rawObj, FIELD_ALIASES.packageSize);
    const warranty = firstSupplied(rawObj, FIELD_ALIASES.warranty);
    const tax = firstSupplied(rawObj, FIELD_ALIASES.tax);
    const leadTime = firstSupplied(rawObj, FIELD_ALIASES.leadTime);
    const visibility = firstSupplied(rawObj, FIELD_ALIASES.visibility);
    const videoUrls = extractVideoUrls(firstSupplied(rawObj, FIELD_ALIASES.videoUrls), baseUrl);
    const tags = stringList(firstSupplied(rawObj, FIELD_ALIASES.tags));
    const keywords = stringList(firstSupplied(rawObj, FIELD_ALIASES.keywords));
    const features = stringList(firstSupplied(rawObj, FIELD_ALIASES.features));
    const extraAttributes = collectExtraAttributes(rawObj);
    const providedFields = canonicalProvidedFields(rawObj);

    return {
      sku,
      title,
      longDescription,
      mediaGallery,
      wholesalePrice,
      recommendedRetailPrice,
      inventoryLevel,
      ...(supplierProductId ? { supplierProductId } : {}),
      ...(barcode ? { barcode } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.brand) ? { brand: optionalString(rawObj, FIELD_ALIASES.brand) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.manufacturer) ? { manufacturer: optionalString(rawObj, FIELD_ALIASES.manufacturer) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.model) ? { model: optionalString(rawObj, FIELD_ALIASES.model) } : {}),
      categoryHierarchy,
      ...(supplierCategory ? { supplierCategory } : {}),
      ...(supplierSubcategory ? { supplierSubcategory } : {}),
      ...(tags ? { tags } : {}),
      ...(keywords ? { keywords } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.productType) ? { productType: optionalString(rawObj, FIELD_ALIASES.productType) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.collection) ? { collection: optionalString(rawObj, FIELD_ALIASES.collection) } : {}),
      ...(attributes ? { attributes } : {}),
      ...(variants ? { variants } : {}),
      ...(options !== undefined ? { options } : {}),
      specifications,
      ...(features ? { features } : {}),
      ...(dimensions !== undefined ? { dimensions } : {}),
      ...(weight !== undefined ? { weight } : {}),
      ...(packageSize !== undefined ? { packageSize } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.shippingClass) ? { shippingClass: optionalString(rawObj, FIELD_ALIASES.shippingClass) } : {}),
      ...(warranty !== undefined ? { warranty } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.countryOfOrigin) ? { countryOfOrigin: optionalString(rawObj, FIELD_ALIASES.countryOfOrigin) } : {}),
      ...(videoUrls ? { videoUrls } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(comparePrice !== undefined ? { comparePrice } : {}),
      ...(costPrice !== undefined ? { costPrice } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.currency) ? { currency: optionalString(rawObj, FIELD_ALIASES.currency) } : {}),
      ...(tax !== undefined ? { tax } : {}),
      ...(optionalNumber(rawObj, FIELD_ALIASES.discount) !== undefined ? { discount: optionalNumber(rawObj, FIELD_ALIASES.discount) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.availability) ? { availability: optionalString(rawObj, FIELD_ALIASES.availability) } : {}),
      ...(leadTime !== undefined ? { leadTime } : {}),
      ...(optionalNumber(rawObj, FIELD_ALIASES.minimumOrderQuantity) !== undefined ? { minimumOrderQuantity: optionalNumber(rawObj, FIELD_ALIASES.minimumOrderQuantity) } : {}),
      ...(optionalNumber(rawObj, FIELD_ALIASES.maximumOrderQuantity) !== undefined ? { maximumOrderQuantity: optionalNumber(rawObj, FIELD_ALIASES.maximumOrderQuantity) } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.status) ? { status: optionalString(rawObj, FIELD_ALIASES.status) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.lastUpdated) ? { lastUpdated: optionalString(rawObj, FIELD_ALIASES.lastUpdated) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.createdDate) ? { createdDate: optionalString(rawObj, FIELD_ALIASES.createdDate) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.slug) ? { slug: optionalString(rawObj, FIELD_ALIASES.slug) } : {}),
      ...(optionalString(rawObj, FIELD_ALIASES.metaDescription) ? { metaDescription: optionalString(rawObj, FIELD_ALIASES.metaDescription) } : {}),
      ...(extraAttributes ? { extraAttributes } : {}),
      ...(providedFields.length > 0 ? { providedFields } : {}),
    };
  }
}
