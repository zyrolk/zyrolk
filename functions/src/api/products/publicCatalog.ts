import type { Firestore } from "firebase-admin/firestore";
import { FieldPath } from "firebase-admin/firestore";

const MAX_PAGE_SIZE = 24;
const MAX_TARGETED_PRODUCT_IDS = 64;
const MAX_CATEGORY_IDS = 100;
const MAX_TEXT_LENGTH = 20_000;

type ProductRecord = Readonly<Record<string, unknown>>;

export interface PublicCatalogProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  promotionEnabled?: boolean;
  discount?: number;
  imageUrl: string;
  imageUrls: string[];
  category: string;
  subcategory?: string;
  brand?: string;
  model?: string;
  productType?: string;
  tags: string[];
  shortDescription?: string;
  keyFeatures: string[];
  whatsIncluded: string[];
  rating: number;
  reviewsCount: number;
  isNew: boolean;
  isFeatured: boolean;
  isBestSeller: boolean;
  isActive: true;
  stock: number;
  specs: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface PublicCatalogPage {
  products: PublicCatalogProduct[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PublicCatalogCounts {
  activeProducts: number;
  byCategory: Record<string, number>;
}

const text = (value: unknown, maximum = MAX_TEXT_LENGTH): string => (
  typeof value === "string" ? value.trim().slice(0, maximum) : ""
);

const optionalText = (value: unknown, maximum = MAX_TEXT_LENGTH): string | undefined => {
  const result = text(value, maximum);
  return result || undefined;
};

const nonNegativeNumber = (value: unknown, fallback = 0): number => {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? Math.max(0, result) : fallback;
};

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
};

const textList = (value: unknown, maximumItems = 40): string[] => (
  Array.isArray(value)
    ? value.map((entry) => text(entry, 240)).filter(Boolean).slice(0, maximumItems)
    : []
);

const safeUrl = (value: unknown): string => {
  const candidate = text(value, 2_048);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
};

const imageList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(safeUrl).filter(Boolean).slice(0, 20)
    : []
);

const publicSpecifications = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [text(key, 100), text(entry, 1_000)] as const)
    .filter(([key, entry]) => Boolean(key && entry))
    .slice(0, 100));
};

const timestampText = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
};

/** Explicit customer-safe allowlist. Supplier/commercial fields are never copied. */
export const projectPublicCatalogProduct = (
  id: string,
  record: ProductRecord,
): PublicCatalogProduct | null => {
  if (record.isActive !== true) return null;
  const name = text(record.name, 240);
  if (!name) return null;
  const imageUrl = safeUrl(record.imageUrl);
  const imageUrls = imageList(record.imageUrls);
  return {
    id,
    name,
    description: text(record.description),
    price: nonNegativeNumber(record.price),
    ...(optionalNumber(record.originalPrice) !== undefined ? { originalPrice: optionalNumber(record.originalPrice) } : {}),
    ...(typeof record.promotionEnabled === "boolean" ? { promotionEnabled: record.promotionEnabled } : {}),
    ...(optionalNumber(record.discount) !== undefined ? { discount: optionalNumber(record.discount) } : {}),
    imageUrl,
    imageUrls,
    category: text(record.category, 160),
    ...(optionalText(record.subcategory, 160) ? { subcategory: optionalText(record.subcategory, 160) } : {}),
    ...(optionalText(record.brand, 160) ? { brand: optionalText(record.brand, 160) } : {}),
    ...(optionalText(record.model, 160) ? { model: optionalText(record.model, 160) } : {}),
    ...(optionalText(record.productType, 160) ? { productType: optionalText(record.productType, 160) } : {}),
    tags: textList(record.tags),
    ...(optionalText(record.shortDescription, 2_000) ? { shortDescription: optionalText(record.shortDescription, 2_000) } : {}),
    keyFeatures: textList(record.keyFeatures),
    whatsIncluded: textList(record.whatsIncluded),
    rating: Math.min(5, nonNegativeNumber(record.rating)),
    reviewsCount: Math.trunc(nonNegativeNumber(record.reviewsCount)),
    isNew: record.isNew === true,
    isFeatured: record.isFeatured === true,
    isBestSeller: record.isBestSeller === true,
    isActive: true,
    stock: Math.trunc(nonNegativeNumber(record.stock)),
    specs: publicSpecifications(record.specs),
    ...(timestampText(record.createdAt) ? { createdAt: timestampText(record.createdAt) } : {}),
    ...(timestampText(record.updatedAt) ? { updatedAt: timestampText(record.updatedAt) } : {}),
  };
};

const normalizedLimit = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
};

const normalizedCursor = (value: unknown): string | undefined => {
  const candidate = text(value, 240);
  return candidate && !candidate.includes("/") && candidate !== "." && candidate !== ".." ? candidate : undefined;
};

const normalizedIds = (value: unknown, maximum: number): string[] => [...new Set(
  (typeof value === "string" ? value.split(",") : [])
    .map((entry) => text(entry, 240))
    .filter((entry) => entry && !entry.includes("/") && entry !== "." && entry !== ".."),
)].slice(0, maximum);

const productsFromDocuments = (documents: readonly { id: string; data: () => ProductRecord | undefined }[]): PublicCatalogProduct[] => (
  documents.flatMap((document) => {
    const product = projectPublicCatalogProduct(document.id, document.data() || {});
    return product ? [product] : [];
  })
);

export const parsePublicCatalogLimit = normalizedLimit;
export const parsePublicCatalogCursor = normalizedCursor;
export const parsePublicCatalogIds = (value: unknown): string[] => normalizedIds(value, MAX_TARGETED_PRODUCT_IDS);
export const parsePublicCatalogCategoryIds = (value: unknown): string[] => normalizedIds(value, MAX_CATEGORY_IDS);

export async function listPublicCatalogProducts(
  db: Firestore,
  input: { limit?: unknown; after?: unknown } = {},
): Promise<PublicCatalogPage> {
  const limit = normalizedLimit(input.limit);
  const cursor = normalizedCursor(input.after);
  let productsQuery = db.collection("products")
    .where("isActive", "==", true)
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (cursor) productsQuery = productsQuery.startAfter(cursor);
  const snapshot = await productsQuery.get();
  return {
    products: productsFromDocuments(snapshot.docs),
    nextCursor: snapshot.docs.length === limit ? snapshot.docs.at(-1)?.id || null : null,
    hasMore: snapshot.docs.length === limit,
  };
}

const homepageQuery = (db: Firestore, field: "isFeatured" | "isNew" | "isBestSeller" | "discount") => {
  const query = db.collection("products").where("isActive", "==", true);
  return field === "discount"
    ? query.where(field, ">", 0).limit(16)
    : query.where(field, "==", true).limit(16);
};

export async function loadPublicHomepageProducts(db: Firestore): Promise<PublicCatalogProduct[]> {
  const snapshots = await Promise.all([
    homepageQuery(db, "isFeatured").get(),
    homepageQuery(db, "isNew").get(),
    homepageQuery(db, "isBestSeller").get(),
    homepageQuery(db, "discount").get(),
  ]);
  const products = new Map<string, PublicCatalogProduct>();
  snapshots.flatMap((snapshot) => productsFromDocuments(snapshot.docs)).forEach((product) => products.set(product.id, product));
  return [...products.values()];
}

export async function loadPublicProductsByIds(db: Firestore, ids: readonly string[]): Promise<PublicCatalogProduct[]> {
  const uniqueIds = [...new Set(ids.map((id) => text(id, 240)).filter((id) => id && !id.includes("/")))].slice(0, MAX_TARGETED_PRODUCT_IDS);
  if (uniqueIds.length === 0) return [];
  const snapshots = await db.getAll(...uniqueIds.map((id) => db.collection("products").doc(id)));
  return productsFromDocuments(snapshots);
}

export async function loadPublicCatalogCounts(
  db: Firestore,
  categoryIds: readonly string[],
): Promise<PublicCatalogCounts> {
  const ids = [...new Set(categoryIds.map((id) => text(id, 160)).filter(Boolean))].slice(0, MAX_CATEGORY_IDS);
  const activeQuery = db.collection("products").where("isActive", "==", true);
  const [activeSnapshot, categoryEntries] = await Promise.all([
    activeQuery.count().get(),
    Promise.all(ids.map(async (categoryId) => {
      const snapshot = await db.collection("products")
        .where("category", "==", categoryId)
        .where("isActive", "==", true)
        .count()
        .get();
      return [categoryId, snapshot.data().count] as const;
    })),
  ]);
  return {
    activeProducts: activeSnapshot.data().count,
    byCategory: Object.fromEntries(categoryEntries),
  };
}
