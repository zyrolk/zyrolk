import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { A2Z_SECRETS } from "../config/secrets";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { COMMERCIAL_PRODUCT_FIELDS, mergeProductData, PRODUCT_PRIVATE_COLLECTION } from "../api/products/productCommercialData";
import { SupplierRegistry } from "../api/suppliers/SupplierRegistry";
import { isValidSupplierImageUrl, ProductParser } from "../api/suppliers/a2z/ProductParser";
import { RawA2ZProduct } from "../api/suppliers/a2z/types";
import {
  buildSupplierImportWarnings,
  detectSupplierProductDetailChanges,
  mergeSupplierCatalogDetails,
  mergeSupplierProductMetadata,
} from "../api/suppliers/supplierProductImport";
import { buildSupplierAuditEvent } from "../api/suppliers/supplierAuditTrail";
import { buildSupplierProductApprovalBaseline } from "../api/suppliers/supplierApprovalConcurrency";
import { buildSupplierHealth, resolveSupplierPriority, SupplierPriorityCandidate } from "../api/suppliers/multiSupplier";
import {
  StoreBrandMappingCandidate,
  StoreCategoryMappingCandidate,
  suggestSupplierBrand,
  suggestSupplierCategory,
  SupplierBrandMappingRecord,
  SupplierBrandSuggestion,
  SupplierCategoryMappingRecord,
  SupplierCategorySuggestion,
  validateSupplierProductForApproval,
} from "../api/suppliers/supplierProductMapping";
import { matchesSupplierCategoryFilter, SupplierCategoryMappings } from "./supplierCategoryMapping";
import {
  calculateSupplierInitialPricing,
  collectDiscoveredSupplierCategories,
  filterSupplierComparison,
  getSupplierImageLimit,
  isSupplierSourceAutoSyncDue,
  resolveSupplierProductLimit,
  SupplierSourceSyncSettings,
} from "./supplierSyncSettings";
import {
  buildSupplierQueueLifecycle,
  classifySupplierQueueFailure,
  processSupplierReviewQueueItem,
} from "./supplierReviewQueue";
import {
  normalizeSupplierCatalogPageSize,
  runSupplierCatalogTraversal,
  SupplierCatalogTraversalCheckpoint,
} from "./supplierCatalogTraversal";

type SyncStatus = "Success" | "Failed" | "Partial" | "Skipped";
type ComparisonStatus = "NEW_PRODUCT" | "PRICE_CHANGED" | "STOCK_CHANGED" | "DESCRIPTION_CHANGED" | "IMAGE_CHANGED" | "UNCHANGED";

interface SupplierSettings {
  websiteSyncEnabled?: boolean;
  autoSyncEnabled?: boolean;
  syncInterval?: string;
  lastSync?: string;
  nextSync?: string;
  maxProducts?: number;
  productLimit?: string | number;
  defaultImageLimit?: number;
  defaultProfitMargin?: number;
  defaultMarkup?: number;
  enabledSupplierIds?: string[];
  enabledSuppliers?: string[];
  enabledSupplierIdsConfigured?: boolean;
  categoryMappings?: SupplierCategoryMappings;
}

interface SupplierSource {
  id: string;
  supplierName?: string;
  name?: string;
  supplierType?: string;
  type?: string;
  connectorType?: string;
  supplierId?: string;
  priority?: unknown;
  capabilities?: string[];
  sourceStatus?: string;
  websiteUrl?: string;
  endpoint?: string;
  config?: {
    targetUrl?: string;
    apiEndpoint?: string;
  };
  settings?: {
    categoriesFilter?: string[];
    brandFilter?: string;
  } & SupplierSourceSyncSettings;
  lastSync?: unknown;
  lastSuccessfulSyncAt?: unknown;
  nextScheduledSyncAt?: unknown;
  currentlySyncing?: unknown;
  syncLeaseExpiresAt?: unknown;
  syncHealth?: Record<string, unknown>;
  syncMetrics?: Record<string, unknown>;
  catalogSync?: Partial<SupplierCatalogTraversalCheckpoint>;
}

interface ExistingProduct {
  id: string;
  name?: string;
  description?: string;
  sku?: string;
  supplierItemCode?: string;
  costPrice?: number;
  marketPrice?: number;
  stock?: number;
  imageUrl?: string;
  imageUrls?: string[];
  category?: string;
  price?: number;
  originalPrice?: number;
  discount?: number;
  specs?: Record<string, string>;
  isNew?: boolean;
  isFeatured?: boolean;
  isBestSeller?: boolean;
  isActive?: boolean;
  active?: boolean;
  published?: boolean;
  approved?: boolean;
  visible?: boolean;
  rating?: number;
  reviewsCount?: number;
  createdAt?: string;
  updatedAt?: unknown;
  supplierId?: string;
  supplierSourceId?: string;
  subcategory?: string;
  brand?: string;
  supplierMetadata?: Record<string, unknown>;
  supplierMedia?: unknown[];
}

interface SyncMetrics {
  productsDiscovered: number;
  productsScanned: number;
  productsQueued: number;
  productsImported: number;
  productsUpdated: number;
  productsDeleted: number;
  productsSkipped: number;
  productsFailed: number;
  retryCount: number;
  sourceFailures: number;
  errors: string[];
  suppliers: string[];
  pagesProcessed: number;
  resumeCount: number;
  sourceCursors: Record<string, string | null>;
  lastCompletedTraversals: Record<string, string>;
}

export interface SupplierSyncRunOptions {
  trigger?: "scheduled" | "manual";
  sourceIds?: string[];
  maxRuntimeMs?: number;
}

export interface SupplierSyncRunResult {
  batchId: string;
  status: SyncStatus;
  productsDiscovered: number;
  productsScanned: number;
  productsQueued: number;
  productsImported: number;
  productsUpdated: number;
  productsDeleted: number;
  productsSkipped: number;
  productsFailed: number;
  retryCount: number;
  sourceFailures: number;
  errors: string[];
  suppliers: string[];
  pagesProcessed: number;
  resumeCount: number;
  sourceCursors: Record<string, string | null>;
  lastCompletedTraversals: Record<string, string>;
  elapsedTimeMs: number;
}

const LOCK_ID = "scheduled_supplier_sync";
const LOCK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PRODUCTS = 5;
const DEFAULT_SYNC_RUNTIME_BUDGET_MS = 7 * 60 * 1000;
/** Deploy-time override; the safe production default is one invocation per hour. */
export const SUPPLIER_SCHEDULER_SCHEDULE = String(process.env.SUPPLIER_SYNC_SCHEDULE || "every 60 minutes").trim() || "every 60 minutes";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateQueueDocId(sourceId: string, supplierCode: string, productName: string): string {
  const sourcePart = generateSlug(sourceId) || "supplier";
  const productPart = generateSlug(supplierCode || productName) || `${Date.now()}`;
  return `${sourcePart}-${productPart}`;
}

function parseIntervalMs(interval: string | undefined): number | null {
  switch ((interval || "").trim().toLowerCase()) {
    case "15 minutes":
      return 15 * 60 * 1000;
    case "30 minutes":
      return 30 * 60 * 1000;
    case "1 hour":
      return 60 * 60 * 1000;
    case "6 hours":
      return 6 * 60 * 60 * 1000;
    case "daily":
      return 24 * 60 * 60 * 1000;
    case "manual":
      return null;
    default:
      return 60 * 60 * 1000;
  }
}

function toMillis(value: unknown): number | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  return null;
}

function isSyncDue(settings: SupplierSettings, nowMs: number): boolean {
  const intervalMs = parseIntervalMs(settings.syncInterval);
  if (!settings.autoSyncEnabled || !intervalMs) {
    return false;
  }

  const nextSyncMs = toMillis(settings.nextSync);
  if (nextSyncMs) {
    return nextSyncMs <= nowMs;
  }

  const lastSyncMs = toMillis(settings.lastSync);
  return !lastSyncMs || lastSyncMs + intervalMs <= nowMs;
}

function getNextSyncIso(settings: SupplierSettings, finishedAtMs: number): string | null {
  const intervalMs = parseIntervalMs(settings.syncInterval);
  return intervalMs ? new Date(finishedAtMs + intervalMs).toISOString() : null;
}

export function getSupplierSourceSyncIntervalMs(autoSync: unknown): number | null {
  switch (String(autoSync || "Off").trim().toLowerCase()) {
    case "15 minutes": return 15 * 60 * 1000;
    case "30 minutes": return 30 * 60 * 1000;
    case "1 hour": return 60 * 60 * 1000;
    case "6 hours": return 6 * 60 * 60 * 1000;
    case "daily": return 24 * 60 * 60 * 1000;
    default: return null;
  }
}

export function getNextSupplierSourceSyncIso(autoSync: unknown, completedAtMs: number): string | null {
  const intervalMs = getSupplierSourceSyncIntervalMs(autoSync);
  return intervalMs ? new Date(completedAtMs + intervalMs).toISOString() : null;
}

const sourceLastSuccessfulSync = (source: SupplierSource): unknown => source.lastSuccessfulSyncAt ?? source.lastSync;

const supplierPriority = (source: SupplierSource): number => {
  const priority = Number(source.priority ?? source.settings?.priority ?? 100);
  return Number.isFinite(priority) ? Math.max(0, Math.min(Math.floor(priority), 10_000)) : 100;
};

const normalizeConflictValue = (value: unknown): string => String(value || "").trim().toLocaleLowerCase();

function getMaxProducts(settings: SupplierSettings): number {
  const configured = Number(settings.maxProducts || DEFAULT_MAX_PRODUCTS);
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_PRODUCTS;
  }
  return Math.min(Math.floor(configured), 250);
}

export function isSupplierSourceEnabled(source: SupplierSource, settings: SupplierSettings): boolean {
  const enabledIds = settings.enabledSupplierIds || settings.enabledSuppliers || [];
  const declaredType = String(source.supplierType || source.type || "").trim().toLowerCase();
  const connectorType = String(source.connectorType || "").trim().toLowerCase();
  const type = declaredType
    ? (["a2z", "http"].includes(declaredType) ? "website" : declaredType)
    : (["a2z", "http"].includes(connectorType) ? "website" : connectorType || "website");
  const status = String(source.sourceStatus || "active").trim().toLowerCase();
  const isActiveWebsite = status === "active" && type === "website";
  const usesExplicitScope = settings.enabledSupplierIdsConfigured === true;
  return isActiveWebsite && ((!usesExplicitScope && enabledIds.length === 0) || enabledIds.includes(source.id));
}

function normalizeSupplierProducts(products: any[]): { products: RawA2ZProduct[]; failed: number } {
  const normalized: RawA2ZProduct[] = [];
  let failed = 0;

  for (const product of products) {
    try {
      normalized.push(ProductParser.parseJsonPayload(product));
    } catch (error) {
      failed += 1;
      logger.warn("Skipping malformed supplier product during scheduled sync.", { error });
    }
  }

  return { products: normalized, failed };
}

function findMatchingProduct(product: RawA2ZProduct, existingProducts: ExistingProduct[]): ExistingProduct | undefined {
  return existingProducts.find((candidate) => {
    const supplierCode = product.sku.trim().toLowerCase();
    const productSlug = generateSlug(product.title);
    return (
      candidate.supplierItemCode?.trim().toLowerCase() === supplierCode ||
      candidate.sku?.trim().toLowerCase() === supplierCode ||
      candidate.id.trim().toLowerCase() === supplierCode ||
      candidate.id.trim().toLowerCase() === productSlug
    );
  });
}

const chunkValues = <T>(values: readonly T[], size = 30): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push([...values.slice(index, index + size)]);
  return chunks;
};

/** Loads only products that can match the supplier batch; it never scans the catalog. */
async function loadExistingProductsForSupplierBatch(products: readonly RawA2ZProduct[]): Promise<ExistingProduct[]> {
  const supplierCodes = [...new Set(products.map((product) => product.sku.trim()).filter(Boolean))];
  const candidateIds = [...new Set(products.flatMap((product) => [product.sku.trim(), generateSlug(product.title)]).filter(Boolean))];
  const privateSnapshots = await Promise.all(chunkValues(supplierCodes).map((codes) => adminDb.collection(PRODUCT_PRIVATE_COLLECTION)
    .where("supplierItemCode", "in", codes)
    .get()));
  const productById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  const directReferences = candidateIds.map((id) => adminDb.collection("products").doc(id));
  if (directReferences.length > 0) {
    const documents = await adminDb.getAll(...directReferences);
    documents.filter((document) => document.exists).forEach((document) => productById.set(document.id, document));
  }
  const privateById = new Map<string, FirebaseFirestore.DocumentData>();
  privateSnapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => privateById.set(document.id, document.data()));
  const privateProductReferences = [...privateById.keys()].filter((id) => !productById.has(id)).map((id) => adminDb.collection("products").doc(id));
  if (privateProductReferences.length > 0) {
    const documents = await adminDb.getAll(...privateProductReferences);
    documents.filter((document) => document.exists).forEach((document) => productById.set(document.id, document));
  }
  return [...productById.values()].map((productDoc) => ({
    ...mergeProductData(productDoc.data() || {}, privateById.get(productDoc.id)),
    id: productDoc.id,
  } as ExistingProduct));
}

interface SupplierQueueCandidateSnapshot {
  review: FirebaseFirestore.QueryDocumentSnapshot[];
  imported: FirebaseFirestore.QueryDocumentSnapshot[];
}

/** Exact supplier-SKU lookups replace the previous review/import queue collection scans. */
async function loadSupplierQueueCandidates(products: readonly RawA2ZProduct[]): Promise<SupplierQueueCandidateSnapshot> {
  const supplierCodes = [...new Set(products.map((product) => product.sku.trim()).filter(Boolean))];
  const snapshots = await Promise.all(chunkValues(supplierCodes).flatMap((codes) => [
    adminDb.collection("supplier_review_queue").select("supplierCode", "barcode", "sourceId", "supplierId", "supplierPriority", "queueState", "status").where("supplierCode", "in", codes).get(),
    adminDb.collection("supplier_import_queue").select("supplierCode", "sku").where("supplierCode", "in", codes).get(),
    adminDb.collection("supplier_import_queue").select("supplierCode", "sku").where("sku", "in", codes).get(),
  ]));
  const review = snapshots.filter((_, index) => index % 3 === 0).flatMap((snapshot) => snapshot.docs);
  const imported = snapshots.filter((_, index) => index % 3 !== 0).flatMap((snapshot) => snapshot.docs);
  return { review, imported };
}

/** Sources are read in deterministic cursor pages so a large registry stays bounded in memory. */
async function loadSupplierSources(requestedSourceIds: readonly string[] = []): Promise<SupplierSource[]> {
  if (requestedSourceIds.length > 0) {
    const documents = await adminDb.getAll(...requestedSourceIds.map((id) => adminDb.collection("supplierSources").doc(id)));
    return documents.filter((document) => document.exists).map((document) => ({ id: document.id, ...document.data() }) as SupplierSource);
  }
  const sources: SupplierSource[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  do {
    let query = adminDb.collection("supplierSources").orderBy(FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    sources.push(...snapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as SupplierSource));
    cursor = snapshot.docs.at(-1);
    if (snapshot.size < 100) break;
  } while (cursor);
  return sources;
}

async function loadSupplierProductMappings(sourceId: string): Promise<{
  categoryMappings: SupplierCategoryMappingRecord[];
  brandMappings: SupplierBrandMappingRecord[];
}> {
  const sourceScopes = [...new Set([sourceId, "*", "global"])];
  const [categorySnapshot, brandSnapshot] = await Promise.all([
    adminDb.collection("supplier_category_mappings").where("sourceId", "in", sourceScopes).get(),
    adminDb.collection("supplier_brand_mappings").where("sourceId", "in", sourceScopes).get(),
  ]);
  return {
    categoryMappings: categorySnapshot.docs.map((document) => document.data() as SupplierCategoryMappingRecord),
    brandMappings: brandSnapshot.docs.map((document) => document.data() as SupplierBrandMappingRecord),
  };
}

function compareProduct(product: RawA2ZProduct, match: ExistingProduct | undefined): { status: ComparisonStatus; changedFields: string[] } {
  if (!match) {
    return { status: "NEW_PRODUCT", changedFields: [] };
  }

  const changedFields: string[] = [];

  if (product.title !== match.name) changedFields.push("Product Name");
  if (product.wholesalePrice !== match.costPrice) changedFields.push("Cost Price");
  if (product.recommendedRetailPrice !== match.marketPrice) changedFields.push("Market Price");
  if (product.inventoryLevel !== match.stock) changedFields.push("Stock");
  if (product.longDescription !== match.description) changedFields.push("Description");
  changedFields.push(...detectSupplierProductDetailChanges(product, { ...match }));

  const supplierImages = [...new Set(product.mediaGallery || [])];
  const auditedSupplierImages = Array.isArray(match.supplierMetadata?.mediaGallery)
    ? match.supplierMetadata.mediaGallery.filter((value): value is string => typeof value === "string")
    : [];
  const existingImages = [...new Set(auditedSupplierImages.length
    ? auditedSupplierImages
    : (match.imageUrls || (match.imageUrl ? [match.imageUrl] : [])))];
  const imagesMatch = supplierImages.length === existingImages.length &&
    supplierImages.every((value, index) => value === existingImages[index]);
  if (!imagesMatch) {
    changedFields.push(supplierImages[0] !== (match.imageUrl || "") ? "Primary Image" : "Images");
  }

  if (changedFields.length === 0) return { status: "UNCHANGED", changedFields };
  if (changedFields.includes("Cost Price") || changedFields.includes("Market Price")) return { status: "PRICE_CHANGED", changedFields };
  if (changedFields.includes("Stock")) return { status: "STOCK_CHANGED", changedFields };
  if (changedFields.includes("Primary Image")) return { status: "IMAGE_CHANGED", changedFields };
  return { status: "DESCRIPTION_CHANGED", changedFields };
}

function buildProductPayload(
  product: RawA2ZProduct,
  match: ExistingProduct | undefined,
  categorySuggestion: SupplierCategorySuggestion,
  brandSuggestion: SupplierBrandSuggestion,
  storeBrands: readonly StoreBrandMappingCandidate[],
  comparison: { status: ComparisonStatus; changedFields: string[] },
  settings: SupplierSettings,
  source: SupplierSource,
): Record<string, unknown> {
  const docId = match ? match.id : (generateSlug(product.title) || product.sku);
  const wholesale = product.wholesalePrice || 0;
  const pricing = calculateSupplierInitialPricing(
    wholesale,
    product.recommendedRetailPrice,
    settings.defaultMarkup,
    settings.defaultProfitMargin,
  );
  const price = pricing.sellingPrice;
  const originalPrice = pricing.comparePrice;
  const imageLimit = getSupplierImageLimit(settings.defaultImageLimit);
  const imageUrls = [...new Set((product.mediaGallery || []).filter(isValidSupplierImageUrl).map((url) => url.trim()))].slice(0, imageLimit);
  const supplierImageUrl = imageUrls[0] || "";
  const isNewProduct = !match;
  const priceUpdateEnabled = isNewProduct || comparison.changedFields.some((field) => field === "Cost Price" || field === "Market Price");
  const stockUpdateEnabled = isNewProduct || comparison.changedFields.includes("Stock");
  const descriptionUpdateEnabled = isNewProduct || comparison.changedFields.some((field) => ![
    "Cost Price", "Market Price", "Stock", "Primary Image", "Images",
  ].includes(field));
  const imageUpdateEnabled = isNewProduct || comparison.changedFields.some((field) => field === "Primary Image" || field === "Images");
  const imageUrl = imageUpdateEnabled ? supplierImageUrl : (match?.imageUrl || "");
  const effectiveImageUrls = imageUpdateEnabled ? imageUrls : (match?.imageUrls || (imageUrl ? [imageUrl] : []));
  const existingIsActive = match
    ? (typeof match.isActive === "boolean" ? match.isActive : (typeof match.active === "boolean" ? match.active : true))
    : true;
  const selectedBrandId = isNewProduct
    ? (brandSuggestion.autoSelected ? brandSuggestion.mappedBrandId : "")
    : (match?.brand || "");
  const selectedBrandName = storeBrands.find((brand) => brand.id === selectedBrandId)?.name || "";
  const baseSpecs = descriptionUpdateEnabled ? (product.specifications || {}) : (match?.specs || {});
  const supplierCatalogDetails = mergeSupplierCatalogDetails(product, { ...(match || {}) }, isNewProduct || descriptionUpdateEnabled || imageUpdateEnabled);
  const supplierMetadata = mergeSupplierProductMetadata(product, match?.supplierMetadata || {});

  return {
    ...supplierCatalogDetails,
    id: docId,
    name: descriptionUpdateEnabled ? product.title : (match?.name || product.title),
    description: descriptionUpdateEnabled ? (product.longDescription || "") : (match?.description || ""),
    price: priceUpdateEnabled ? price : (match?.price || price),
    originalPrice: priceUpdateEnabled ? originalPrice : (match?.originalPrice || match?.price || originalPrice),
    discount: priceUpdateEnabled ? pricing.discountPercent : (match?.discount || 0),
    stock: stockUpdateEnabled ? product.inventoryLevel : (match?.stock || 0),
    imageUrl,
    imageUrls: effectiveImageUrls,
    category: isNewProduct && categorySuggestion.autoSelected ? categorySuggestion.targetCategoryId : (match?.category || ""),
    subcategory: isNewProduct && categorySuggestion.autoSelected ? categorySuggestion.targetSubcategoryId : (match?.subcategory || ""),
    brand: selectedBrandId,
    specs: { ...baseSpecs, ...(selectedBrandName ? { Brand: selectedBrandName } : {}) },
    isNew: isNewProduct ? true : match?.isNew === true,
    isFeatured: isNewProduct ? false : match?.isFeatured === true,
    isBestSeller: isNewProduct ? false : match?.isBestSeller === true,
    isActive: existingIsActive,
    active: existingIsActive,
    published: isNewProduct ? true : match?.published !== false,
    approved: isNewProduct ? true : match?.approved !== false,
    visible: isNewProduct ? true : match?.visible !== false,
    sku: product.sku,
    ...(product.barcode ? { barcode: product.barcode } : {}),
    supplierId: source.supplierId || source.id,
    supplierSourceId: source.id,
    supplierPriority: supplierPriority(source),
    supplierItemCode: product.sku,
    supplierMetadata,
    supplierMedia: imageUpdateEnabled ? [] : (match?.supplierMedia || []),
    costPrice: priceUpdateEnabled ? wholesale : (match?.costPrice || 0),
    marketPrice: priceUpdateEnabled ? (product.recommendedRetailPrice || 0) : (match?.marketPrice || 0),
    rating: match?.rating ?? 0,
    reviewsCount: match?.reviewsCount ?? 0,
    createdAt: match?.createdAt || new Date().toISOString(),
  };
}

function buildPendingChange(
  queueItem: Record<string, unknown>,
  product: RawA2ZProduct,
  match: ExistingProduct | undefined,
  comparisonStatus: ComparisonStatus,
): Record<string, unknown> | null {
  if (comparisonStatus === "UNCHANGED" || comparisonStatus === "NEW_PRODUCT") {
    return null;
  }

  let oldValue = "";
  let newValue = "";

  if (comparisonStatus === "PRICE_CHANGED") {
    oldValue = match ? `LKR ${(match.costPrice || 0).toLocaleString()}` : "Unknown";
    newValue = `LKR ${(product.wholesalePrice || 0).toLocaleString()}`;
  } else if (comparisonStatus === "STOCK_CHANGED") {
    oldValue = match ? `${match.stock || 0} units` : "Unknown";
    newValue = `${product.inventoryLevel || 0} units`;
  } else if (comparisonStatus === "IMAGE_CHANGED") {
    oldValue = match?.imageUrl || "";
    newValue = product.mediaGallery?.[0] || "";
  } else {
    oldValue = "Previous description";
    newValue = "Updated description";
  }

  return {
    id: `change-${queueItem.id}`,
    reviewQueueItemId: queueItem.id,
    productName: queueItem.productName,
    supplierCode: queueItem.supplierCode,
    supplierName: queueItem.supplierName,
    changeType: comparisonStatus,
    source: "Website",
    sourceId: queueItem.sourceId,
    batchId: queueItem.batchId,
    detectedAt: new Date().toISOString(),
    createdAt: queueItem.createdAt,
    oldValue,
    newValue,
    status: "Pending",
    productPayload: queueItem.productPayload,
    supplierSnapshot: queueItem.supplierSnapshot,
    matchedProductId: queueItem.matchedProductId,
    approvalBaseline: queueItem.approvalBaseline,
  };
}

interface SupplierSyncConflictWinner extends SupplierPriorityCandidate {
  queueItemId: string;
}

function buildSupplierConflictRecord(
  source: SupplierSource,
  product: RawA2ZProduct,
  winner: SupplierSyncConflictWinner,
  reason: "duplicate_sku" | "duplicate_barcode" | "duplicate_supplier_product",
  batchId: string,
): { id: string; data: Record<string, unknown> } {
  const value = reason === "duplicate_barcode" ? normalizeConflictValue(product.barcode) : normalizeConflictValue(product.sku);
  const id = `conflict-${generateSlug(`${reason}-${source.id}-${value}`)}`.slice(0, 180);
  return {
    id,
    data: {
      id,
      reason,
      status: "open",
      batchId,
      supplierId: source.supplierId || source.id,
      sourceId: source.id,
      supplierPriority: supplierPriority(source),
      supplierSku: product.sku,
      barcode: product.barcode || null,
      productName: product.title,
      conflictingSupplierId: winner.supplierId,
      conflictingSourceId: winner.sourceId,
      conflictingQueueItemId: winner.queueItemId,
      winningPriority: winner.priority,
      resolution: "higher_priority_supplier_retained",
      detectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

async function acquireSyncLock(startedAt: Date, batchId: string, trigger: "scheduled" | "manual"): Promise<boolean> {
  const lockRef = adminDb.collection("supplier_sync_locks").doc(LOCK_ID);
  const nowMs = startedAt.getTime();

  return adminDb.runTransaction(async (transaction) => {
    const lockSnap = await transaction.get(lockRef);
    const lockData = lockSnap.exists ? lockSnap.data() : null;
    const lockedUntilMs = toMillis(lockData?.lockedUntil);

    if (lockData?.status === "running" && lockedUntilMs && lockedUntilMs > nowMs) {
      return false;
    }

    transaction.set(lockRef, {
      status: "running",
      owner: batchId,
      trigger,
      activeSyncCount: 1,
      startedAt: startedAt.toISOString(),
      lockedUntil: new Date(nowMs + LOCK_TTL_MS).toISOString(),
      updatedAt: startedAt.toISOString(),
    }, { merge: true });

    return true;
  });
}

async function releaseSyncLock(finishedAt: Date): Promise<void> {
  await adminDb.collection("supplier_sync_locks").doc(LOCK_ID).set({
    status: "idle",
    activeSyncCount: 0,
    finishedAt: finishedAt.toISOString(),
    updatedAt: finishedAt.toISOString(),
  }, { merge: true });
}

async function recoverStaleSourceSyncLeases(nowMs: number): Promise<number> {
  const staleSources = await adminDb.collection("supplierSources")
    .where("currentlySyncing", "==", true)
    .where("syncLeaseExpiresAt", "<=", new Date(nowMs).toISOString())
    .orderBy("syncLeaseExpiresAt", "asc")
    .limit(100)
    .get();
  let recovered = 0;
  let batch = adminDb.batch();
  let operations = 0;
  for (const source of staleSources.docs) {
    const leaseExpiresAt = toMillis(source.data().syncLeaseExpiresAt);
    if (!leaseExpiresAt || leaseExpiresAt > nowMs) continue;
    batch.set(source.ref, {
      currentlySyncing: false,
      syncRecoveredAt: new Date(nowMs).toISOString(),
      syncRecoveryReason: "Previous supplier sync lease expired.",
      syncLeaseExpiresAt: FieldValue.delete(),
    }, { merge: true });
    batch.set(adminDb.collection("supplier_sync_locks").doc(`source-${source.id}`), {
      status: "idle",
      activeSyncCount: 0,
      recoveredAt: new Date(nowMs).toISOString(),
      lockedUntil: FieldValue.delete(),
    }, { merge: true });
    recovered += 1;
    operations += 2;
    if (operations >= 448) {
      await batch.commit();
      batch = adminDb.batch();
      operations = 0;
    }
  }
  if (operations > 0) await batch.commit();
  return recovered;
}

async function markSourcesSyncing(sources: readonly SupplierSource[], batchId: string, startedAtMs: number): Promise<SupplierSource[]> {
  const acquired: SupplierSource[] = [];
  for (const source of sources) {
    const sourceReference = adminDb.collection("supplierSources").doc(source.id);
    const lockReference = adminDb.collection("supplier_sync_locks").doc(`source-${source.id}`);
    const leased = await adminDb.runTransaction(async (transaction) => {
      const lockSnapshot = await transaction.get(lockReference);
      const lock = lockSnapshot.data() || {};
      const lockExpiresAt = toMillis(lock.lockedUntil);
      if (lock.status === "running" && lockExpiresAt && lockExpiresAt > startedAtMs) return false;
      transaction.set(lockReference, {
        status: "running",
        owner: batchId,
        supplierId: source.supplierId || source.id,
        sourceId: source.id,
        activeSyncCount: 1,
        startedAt: new Date(startedAtMs).toISOString(),
        lockedUntil: new Date(startedAtMs + LOCK_TTL_MS).toISOString(),
      }, { merge: true });
      transaction.set(sourceReference, {
        currentlySyncing: true,
        syncBatchId: batchId,
        syncStartedAt: new Date(startedAtMs).toISOString(),
        syncLeaseExpiresAt: new Date(startedAtMs + LOCK_TTL_MS).toISOString(),
      }, { merge: true });
      return true;
    });
    if (leased) acquired.push(source);
  }
  return acquired;
}

async function clearInterruptedSourceSyncMarkers(sources: readonly SupplierSource[], batchId: string, reason: string): Promise<void> {
  for (const source of sources) {
    const reference = adminDb.collection("supplierSources").doc(source.id);
    const lockReference = adminDb.collection("supplier_sync_locks").doc(`source-${source.id}`);
    await adminDb.runTransaction(async (transaction) => {
      const [snapshot, lockSnapshot] = await Promise.all([transaction.get(reference), transaction.get(lockReference)]);
      if (!snapshot.exists || snapshot.data()?.syncBatchId !== batchId) return;
      transaction.set(reference, {
        currentlySyncing: false,
        syncInterruptedAt: new Date().toISOString(),
        syncInterruptionReason: reason.slice(0, 1_000),
        syncLeaseExpiresAt: FieldValue.delete(),
      }, { merge: true });
      if (lockSnapshot.data()?.owner === batchId) {
        transaction.set(lockReference, {
          status: "idle",
          activeSyncCount: 0,
          finishedAt: new Date().toISOString(),
          lockedUntil: FieldValue.delete(),
        }, { merge: true });
      }
    });
  }
}

async function releaseSourceSyncLeases(sources: readonly SupplierSource[], batchId: string, finishedAtMs: number): Promise<void> {
  for (const source of sources) {
    const sourceReference = adminDb.collection("supplierSources").doc(source.id);
    const lockReference = adminDb.collection("supplier_sync_locks").doc(`source-${source.id}`);
    await adminDb.runTransaction(async (transaction) => {
      const [sourceSnapshot, lockSnapshot] = await Promise.all([transaction.get(sourceReference), transaction.get(lockReference)]);
      if (sourceSnapshot.exists && sourceSnapshot.data()?.syncBatchId === batchId) {
        transaction.set(sourceReference, {
          currentlySyncing: false,
          syncLeaseExpiresAt: FieldValue.delete(),
          syncFinishedAt: new Date(finishedAtMs).toISOString(),
        }, { merge: true });
      }
      if (lockSnapshot.data()?.owner === batchId) {
        transaction.set(lockReference, {
          status: "idle",
          activeSyncCount: 0,
          finishedAt: new Date(finishedAtMs).toISOString(),
          lockedUntil: FieldValue.delete(),
        }, { merge: true });
      }
    });
  }
}

async function writeHistory(
  batchId: string,
  trigger: "scheduled" | "manual",
  status: SyncStatus,
  startedAt: Date,
  finishedAt: Date,
  metrics: SyncMetrics,
  details: string,
): Promise<void> {
  await adminDb.collection("supplier_sync_history").doc(batchId).set({
    id: batchId,
    batchId,
    trigger,
    timestamp: finishedAt.toLocaleTimeString("en-US", { timeZone: "Asia/Colombo" }),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    supplier: metrics.suppliers.join(", ") || "Scheduled Supplier Sync",
    supplierCode: metrics.suppliers.join(", ") || "Scheduled",
    status,
    productsDiscovered: metrics.productsDiscovered,
    productsScanned: metrics.productsScanned,
    productsQueued: metrics.productsQueued,
    productsImported: metrics.productsImported,
    productsUpdated: metrics.productsUpdated,
    productsDeleted: metrics.productsDeleted,
    productsSkipped: metrics.productsSkipped,
    productsFailed: metrics.productsFailed,
    retryCount: metrics.retryCount,
    pagesProcessed: metrics.pagesProcessed,
    resumeCount: metrics.resumeCount,
    sourceCursors: metrics.sourceCursors,
    lastCompletedTraversals: metrics.lastCompletedTraversals,
    sourceFailures: metrics.sourceFailures,
    productsSynced: metrics.productsScanned,
    errors: metrics.errors,
    details,
    createdAt: finishedAt.toISOString(),
  }, { merge: true });
}

interface SupplierSyncWrite {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  create?: boolean;
  /** Queue record plus its initial audit event must commit together. */
  atomicGroup?: string;
}

async function commitQueuedItems(items: SupplierSyncWrite[]): Promise<void> {
  let batch = adminDb.batch();
  let operationCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const nextItem = items[index + 1];
    // Keep an adjacent queue/audit pair in the same Firestore batch even when
    // the preceding source-setting write left only one operation available.
    if (operationCount > 0 && operationCount >= 449 && item.atomicGroup && nextItem?.atomicGroup === item.atomicGroup) {
      await batch.commit();
      batch = adminDb.batch();
      operationCount = 0;
    }
    const reference = adminDb.collection(item.collection).doc(item.id);
    if (item.create) batch.create(reference, item.data);
    else batch.set(reference, item.data, { merge: true });
    operationCount++;

    if (operationCount >= 450) {
      await batch.commit();
      batch = adminDb.batch();
      operationCount = 0;
    }
  }

  if (operationCount > 0) {
    await batch.commit();
  }
}

async function processSupplierQueueItemsBounded(queueItemIds: readonly string[], workerId: string, concurrency = 5) {
  const results = [];
  const safeConcurrency = Math.max(1, Math.min(Math.floor(concurrency), 10));
  for (let offset = 0; offset < queueItemIds.length; offset += safeConcurrency) {
    results.push(...await Promise.all(queueItemIds.slice(offset, offset + safeConcurrency).map((queueItemId) => (
      processSupplierReviewQueueItem(adminDb, queueItemId, workerId)
    ))));
  }
  return results;
}

export function isSupplierProductEligibleForRemovalReview(product: Record<string, unknown>): boolean {
  return product.isActive !== false && product.active !== false && product.visible !== false;
}

export function buildSupplierRemovalProductPayload(
  productId: string,
  publicProduct: Record<string, unknown>,
  privateProduct: Record<string, unknown>,
): Record<string, unknown> {
  const commercialData = Object.fromEntries(COMMERCIAL_PRODUCT_FIELDS
    .filter((field) => Object.hasOwn(privateProduct, field))
    .map((field) => [field, privateProduct[field]]));
  return {
    ...publicProduct,
    ...commercialData,
    id: productId,
    stock: 0,
    isActive: false,
    active: false,
    visible: false,
  };
}

async function queueMissingSupplierProductsForReview(
  source: SupplierSource,
  traversal: SupplierCatalogTraversalCheckpoint,
  batchId: string,
): Promise<{ queued: number; queueItemIds: string[] }> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let queued = 0;
  const queueItemIds: string[] = [];
  do {
    let query = adminDb.collection(PRODUCT_PRIVATE_COLLECTION)
      .where("supplierSourceId", "==", source.id)
      .orderBy(FieldPath.documentId())
      .limit(100);
    if (cursor) query = query.startAfter(cursor);
    const privateSnapshot = await query.get();
    cursor = privateSnapshot.docs.at(-1);
    const missingDocuments = privateSnapshot.docs.filter((document) => (
      document.data().supplierCatalogTraversalId !== traversal.traversalId
    ));
    if (missingDocuments.length > 0) {
      const productSnapshots = await adminDb.getAll(...missingDocuments.map((document) => adminDb.collection("products").doc(document.id)));
      const candidates = productSnapshots.filter((snapshot) => {
        if (!snapshot.exists) return false;
        const product = snapshot.data() || {};
        return isSupplierProductEligibleForRemovalReview(product);
      });
      const candidateQueueIds = candidates.map((snapshot) => (
        `reconcile-${generateSlug(source.id)}-${generateSlug(snapshot.id)}-${generateSlug(traversal.traversalId)}`.slice(0, 180)
      ));
      const existingQueueSnapshots = candidateQueueIds.length > 0
        ? await adminDb.getAll(...candidateQueueIds.map((id) => adminDb.collection("supplier_review_queue").doc(id)))
        : [];
      const existingQueueIds = new Set(existingQueueSnapshots.filter((snapshot) => snapshot.exists).map((snapshot) => snapshot.id));
      const writes: SupplierSyncWrite[] = [];
      const pageQueueItemIds: string[] = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const productSnapshot = candidates[index];
        const queueItemId = candidateQueueIds[index];
        if (existingQueueIds.has(queueItemId)) continue;
        const privateProduct = missingDocuments.find((document) => document.id === productSnapshot.id)?.data() || {};
        const currentProduct = productSnapshot.data() || {};
        const productPayload = buildSupplierRemovalProductPayload(productSnapshot.id, currentProduct, privateProduct);
        const createdAt = new Date().toISOString();
        const supplierSnapshot = {
          supplierId: source.supplierId || source.id,
          sourceId: source.id,
          supplierName: source.supplierName || source.name || source.id,
          supplierSku: String(privateProduct.supplierItemCode || currentProduct.sku || ""),
          reconciliationAction: "deactivate_and_zero_stock",
          missingFromTraversalId: traversal.traversalId,
          lastSeenTraversalId: privateProduct.supplierCatalogTraversalId || null,
        };
        const queueData = {
          id: queueItemId,
          status: "Pending",
          supplierCode: supplierSnapshot.supplierSku,
          supplierName: supplierSnapshot.supplierName,
          source: "Website",
          connector: String(source.connectorType || source.supplierType || source.type || "website"),
          sourceId: source.id,
          supplierId: source.supplierId || source.id,
          supplierPriority: supplierPriority(source),
          batchId,
          productName: String(currentProduct.name || productSnapshot.id),
          costPrice: Number(privateProduct.costPrice || privateProduct.supplierPurchasePrice || 0),
          marketPrice: Number(currentProduct.originalPrice || currentProduct.price || 0),
          stock: 0,
          imageUrl: String(currentProduct.imageUrl || ""),
          comparisonStatus: "STOCK_CHANGED",
          comparison: {
            matchFound: true,
            matchedProductId: productSnapshot.id,
            comparisonStatus: "STOCK_CHANGED",
            changedFields: ["Supplier listing removed", "Stock", "Visibility"],
          },
          reconciliationAction: "deactivate_and_zero_stock",
          productPayload,
          supplierSnapshot,
          matchedProductId: productSnapshot.id,
          approvalBaseline: buildSupplierProductApprovalBaseline(productSnapshot.id, currentProduct, createdAt),
          ...buildSupplierQueueLifecycle(createdAt),
          correlationId: queueItemId,
          createdAt,
          updatedAt: createdAt,
        };
        writes.push({ collection: "supplier_review_queue", id: queueItemId, data: queueData, atomicGroup: queueItemId });
        const auditReference = adminDb.collection("supplier_approval_audit").doc();
        writes.push({
          collection: "supplier_approval_audit",
          id: auditReference.id,
          create: true,
          atomicGroup: queueItemId,
          data: buildSupplierAuditEvent({
            queueItemId,
            queueItem: queueData,
            action: "queued",
            previousState: null,
            newState: "queued",
            reason: "Product was absent from a verified complete supplier catalog traversal and requires administrator review.",
          }, auditReference.id),
        });
        queueItemIds.push(queueItemId);
        pageQueueItemIds.push(queueItemId);
        queued += 1;
      }
      await commitQueuedItems(writes);
      await processSupplierQueueItemsBounded(pageQueueItemIds, `supplier-reconciliation-${batchId}`);
    }
    if (privateSnapshot.size < 100) break;
  } while (cursor);
  return { queued, queueItemIds };
}

const buildRunResult = (batchId: string, status: SyncStatus, metrics: SyncMetrics): SupplierSyncRunResult => ({
  batchId,
  status,
  productsDiscovered: metrics.productsDiscovered,
  productsScanned: metrics.productsScanned,
  productsQueued: metrics.productsQueued,
  productsImported: metrics.productsImported,
  productsUpdated: metrics.productsUpdated,
  productsDeleted: metrics.productsDeleted,
  productsSkipped: metrics.productsSkipped,
  productsFailed: metrics.productsFailed,
  retryCount: metrics.retryCount,
  sourceFailures: metrics.sourceFailures,
  errors: [...metrics.errors],
  suppliers: [...metrics.suppliers],
  pagesProcessed: metrics.pagesProcessed,
  resumeCount: metrics.resumeCount,
  sourceCursors: { ...metrics.sourceCursors },
  lastCompletedTraversals: { ...metrics.lastCompletedTraversals },
  elapsedTimeMs: Math.max(0, Date.now() - Number(batchId.split("-").at(-1) || Date.now())),
});

export async function runSupplierSync(options: SupplierSyncRunOptions = {}): Promise<SupplierSyncRunResult> {
  const trigger = options.trigger || "scheduled";
  const requestedSourceIds = [...new Set((options.sourceIds || []).map((sourceId) => sourceId.trim()).filter(Boolean))];
  const startedAt = new Date();
  const runtimeBudgetMs = Number.isFinite(options.maxRuntimeMs) && Number(options.maxRuntimeMs) > 0
    ? Number(options.maxRuntimeMs)
    : DEFAULT_SYNC_RUNTIME_BUDGET_MS;
  const syncDeadlineMs = startedAt.getTime() + runtimeBudgetMs;
  const batchId = `${trigger}-${startedAt.getTime()}`;
  const metrics: SyncMetrics = {
    productsDiscovered: 0,
    productsScanned: 0,
    productsQueued: 0,
    productsImported: 0,
    productsUpdated: 0,
    productsDeleted: 0,
    productsSkipped: 0,
    productsFailed: 0,
    retryCount: 0,
    sourceFailures: 0,
    errors: [],
    suppliers: [],
    pagesProcessed: 0,
    resumeCount: 0,
    sourceCursors: {},
    lastCompletedTraversals: {},
  };
  const queueWorkerId = `supplier-sync-${trigger}-${batchId}`;
  let incompleteTraversalCount = 0;

  const settingsSnap = await adminDb.collection("supplier_settings").doc("config").get();
  const settings = (settingsSnap.exists ? settingsSnap.data() : {}) as SupplierSettings;

  appLogger.info("Scheduled supplier sync evaluated.", {
    batchId,
    autoSyncEnabled: !!settings.autoSyncEnabled,
    syncInterval: settings.syncInterval || "unspecified",
  });

  if (trigger === "scheduled" && !isSyncDue(settings, startedAt.getTime())) {
    appLogger.info("Scheduled supplier sync skipped because it is not due.", { batchId });
    await writeHistory(batchId, trigger, "Skipped", startedAt, new Date(), metrics, "Scheduled supplier sync was not due yet.");
    return buildRunResult(batchId, "Skipped", metrics);
  }

  if (settings.websiteSyncEnabled === false) {
    appLogger.info("Scheduled supplier sync skipped because the Website Sync Channel is disabled.", { batchId });
    await writeHistory(batchId, trigger, "Skipped", startedAt, new Date(), metrics, "Supplier website sync is disabled.");
    return buildRunResult(batchId, "Skipped", metrics);
  }

  let sources = (await loadSupplierSources(requestedSourceIds))
    .filter((source) => isSupplierSourceEnabled(source, settings))
    .filter((source) => requestedSourceIds.length === 0 || requestedSourceIds.includes(source.id))
    .filter((source) => trigger === "manual" || isSupplierSourceAutoSyncDue(source.settings?.autoSync, sourceLastSuccessfulSync(source), startedAt.getTime()))
    .sort((left, right) => supplierPriority(right) - supplierPriority(left) || left.id.localeCompare(right.id));

  if (sources.length === 0) {
    appLogger.info("Supplier sync found no enabled sources due for synchronization.", { batchId, trigger, requestedSourceIds });
    await writeHistory(batchId, trigger, "Skipped", startedAt, new Date(), metrics, "No enabled supplier sources were due for synchronization.");
    return buildRunResult(batchId, "Skipped", metrics);
  }

  const hasWritableSources = sources.some((source) => source.settings?.dryRunMode !== true);
  let syncLockAcquired = false;
  if (hasWritableSources) syncLockAcquired = await acquireSyncLock(startedAt, batchId, trigger);
  if (hasWritableSources && !syncLockAcquired) {
    const finishedAt = new Date();
    await writeHistory(batchId, trigger, "Skipped", startedAt, finishedAt, metrics, "Supplier sync skipped because another supplier sync is already running.");
    appLogger.warn("Scheduled supplier sync skipped because lock is already held.", { batchId });
    return buildRunResult(batchId, "Skipped", metrics);
  }

  try {
    if (hasWritableSources) {
      const recoveredSourceLeases = await recoverStaleSourceSyncLeases(startedAt.getTime());
      const leasedSources = await markSourcesSyncing(sources.filter((source) => source.settings?.dryRunMode !== true), batchId, startedAt.getTime());
      const leasedSourceIds = new Set(leasedSources.map((source) => source.id));
      sources = sources.filter((source) => source.settings?.dryRunMode === true || leasedSourceIds.has(source.id));
      await adminDb.collection("supplier_settings").doc("config").set({
        schedulerStatus: "running",
        schedulerActiveSyncCount: 1,
        schedulerCurrentBatchId: batchId,
        schedulerCurrentTrigger: trigger,
        schedulerStartedAt: startedAt.toISOString(),
        ...(recoveredSourceLeases > 0 ? { schedulerRecoveredSourceLeases: recoveredSourceLeases } : {}),
      }, { merge: true });
      if (sources.length === 0) {
        const finishedAt = new Date();
        await writeHistory(batchId, trigger, "Skipped", startedAt, finishedAt, metrics, "All requested supplier sources are protected by active source leases.");
        await adminDb.collection("supplier_settings").doc("config").set({
          schedulerStatus: "idle",
          schedulerActiveSyncCount: 0,
        }, { merge: true });
        return buildRunResult(batchId, "Skipped", metrics);
      }
    }
    appLogger.info("Scheduled supplier sync started.", { batchId });

    const [categoriesSnap, brandsSnap] = await Promise.all([
      adminDb.collection("categories").get(),
      adminDb.collection("brands").get(),
    ]);
    const storeCategories: StoreCategoryMappingCandidate[] = categoriesSnap.docs.map((categoryDoc) => ({
      id: categoryDoc.id,
      name: String(categoryDoc.data().name || categoryDoc.id),
      isActive: categoryDoc.data().isActive !== false,
      subcategories: Array.isArray(categoryDoc.data().subcategories) ? categoryDoc.data().subcategories : [],
      specificationTemplate: Array.isArray(categoryDoc.data().specificationTemplate) ? categoryDoc.data().specificationTemplate : [],
      keywords: Array.isArray(categoryDoc.data().keywords) ? categoryDoc.data().keywords : [],
    }));
    const storeBrands: StoreBrandMappingCandidate[] = brandsSnap.docs.map((brandDoc) => ({
      id: brandDoc.id,
      name: String(brandDoc.data().name || brandDoc.id),
      isActive: brandDoc.data().isActive !== false,
      aliases: Array.isArray(brandDoc.data().aliases) ? brandDoc.data().aliases : [],
    }));

    const existingQueueIds = new Set<string>();
    const queuedSupplierCodes = new Set<string>();
    const existingQueueWinnerBySku = new Map<string, SupplierSyncConflictWinner>();

    const maxProducts = getMaxProducts(settings);
    const imageLimit = getSupplierImageLimit(settings.defaultImageLimit);
    const connectors = await SupplierRegistry.createConnectorsForSources(
      sources.map((source) => ({ id: source.id, data: source as FirebaseFirestore.DocumentData })),
      settings.enabledSupplierIds || settings.enabledSuppliers || [],
    );
    const connectorBySourceId = new Map(connectors.map((connector) => [connector.id, connector]));
    const queuedWrites: SupplierSyncWrite[] = [];
    const stagedReviewQueueIds: string[] = [];
    const seenSupplierProducts = new Map<string, SupplierSyncConflictWinner>();
    const winnerBySku = new Map<string, SupplierSyncConflictWinner>(existingQueueWinnerBySku);
    const winnerByBarcode = new Map<string, SupplierSyncConflictWinner>();
    let dryRunComparisonCount = 0;
    let nonDrySourceCount = 0;

    for (const source of sources) {
      const supplierName = source.supplierName || source.name || source.id;
      const websiteUrl = source.websiteUrl || source.config?.targetUrl || "";
      const endpoint = source.endpoint || source.config?.apiEndpoint || "";
      const sourceSettings = source.settings || {};
      const dryRunMode = sourceSettings.dryRunMode === true;
      const sourceStartedAt = Date.now();
      let sourceRejected = 0;
      let sourceProductsDiscovered = 0;
      let sourceProductsFailed = 0;
      let sourceQueueDepth = 0;
      const discoveredCategoryLabels = new Set<string>();
      const sourceWriteOffset = queuedWrites.length;
      const sourceStagedOffset = stagedReviewQueueIds.length;
      const legacyCategoryMappings: SupplierCategoryMappingRecord[] = Object.entries(settings.categoryMappings || {}).map(([supplierCategory, targetCategoryId]) => ({
        sourceId: "global",
        supplierCategory,
        normalizedCategory: supplierCategory,
        targetCategoryId: String(targetCategoryId || ""),
        targetSubcategoryId: "",
        confidence: 100,
        mappingType: "manual",
        version: 1,
        updatedBy: "legacy-settings",
      }));
      if (!dryRunMode) nonDrySourceCount++;

      if (!websiteUrl) {
        metrics.errors.push(`${supplierName}: [validation] missing website URL`);
        metrics.sourceFailures += 1;
        if (!dryRunMode) {
          queuedWrites.push({
            collection: "supplierSources",
            id: source.id,
            data: {
              connectionStatus: "Failed",
              lastError: "Missing website URL",
              lastFailureClassification: "validation",
              lastFailedSyncAt: new Date().toISOString(),
              nextScheduledSyncAt: getNextSupplierSourceSyncIso(sourceSettings.autoSync, Date.now()),
              currentlySyncing: false,
              syncLeaseExpiresAt: FieldValue.delete(),
              syncMetrics: {
                productsDiscovered: 0,
                productsImported: 0,
                productsRejected: 0,
                productsFailed: 1,
                retries: Number(source.syncMetrics?.retries || 0) + 1,
                queueDepth: 0,
                durationMs: Math.max(0, Date.now() - sourceStartedAt),
                updatedAt: new Date().toISOString(),
              },
              syncHealth: buildSupplierHealth(source.syncHealth || {}, "failure", Math.max(0, Date.now() - sourceStartedAt), new Date().toISOString()),
            },
          });
        }
        continue;
      }

      try {
        const storedMappings = await loadSupplierProductMappings(source.id);
        const categoryMappingRecords = [...storedMappings.categoryMappings, ...legacyCategoryMappings];
        const connector = connectorBySourceId.get(source.id) ||
          await SupplierRegistry.createConnectorForTarget(websiteUrl, endpoint, {
            id: source.id,
            supplierId: source.supplierId || source.id,
            name: supplierName,
            connectorType: source.connectorType || source.supplierType || source.type || "http",
            enabled: true,
            priority: supplierPriority(source),
            capabilities: source.capabilities || ["catalog.fetch", "connection.test"],
          });
        const resumesTraversal = ["in_progress", "paused", "reconciling"].includes(String(source.catalogSync?.status || ""));
        const initialTraversalPages = resumesTraversal ? Number(source.catalogSync?.pagesProcessed || 0) : 0;
        const initialResumeCount = resumesTraversal ? Number(source.catalogSync?.resumeCount || 0) : 0;
        const sourcePageSize = resolveSupplierProductLimit(sourceSettings.productLimit, settings.productLimit, maxProducts);
        const traversalResult = await runSupplierCatalogTraversal({
          connector,
          pageSize: normalizeSupplierCatalogPageSize(sourcePageSize),
          initial: source.catalogSync,
          shouldPause: () => Date.now() >= syncDeadlineMs,
          persistCheckpoint: async (checkpoint) => {
            if (dryRunMode) return;
            await adminDb.collection("supplierSources").doc(source.id).set({
              catalogCursor: checkpoint.cursor,
              catalogSync: checkpoint,
              catalogSyncMetrics: {
                pagesProcessed: checkpoint.pagesProcessed,
                productsScanned: checkpoint.productsScanned,
                productsImported: checkpoint.productsImported,
                cursor: checkpoint.cursor,
                elapsedTimeMs: Math.max(0, Date.now() - new Date(checkpoint.startedAt).getTime()),
                lastCompletedTraversal: checkpoint.status === "completed" ? checkpoint.traversalId : null,
                resumeCount: checkpoint.resumeCount,
                updatedAt: checkpoint.lastCheckpointAt,
              },
              ...(checkpoint.status === "completed" ? {
                lastCompletedCatalogTraversal: {
                  traversalId: checkpoint.traversalId,
                  pagesProcessed: checkpoint.pagesProcessed,
                  productsScanned: checkpoint.productsScanned,
                  productsImported: checkpoint.productsImported,
                  startedAt: checkpoint.startedAt,
                  completedAt: checkpoint.lastCheckpointAt,
                  resumeCount: checkpoint.resumeCount,
                },
              } : {}),
            }, { merge: true });
          },
          reconcileDeletedProducts: async (checkpoint) => {
            if (dryRunMode) return;
            const reconciliation = await queueMissingSupplierProductsForReview(source, checkpoint, batchId);
            metrics.productsQueued += reconciliation.queued;
            metrics.productsDeleted += reconciliation.queued;
            sourceRejected += reconciliation.queued;
          },
          processPage: async (fetched, traversalCheckpoint) => {
            const pageWriteOffset = queuedWrites.length;
            const pageStagedOffset = stagedReviewQueueIds.length;
            const queuedBeforePage = metrics.productsQueued;
        const normalizedProducts = normalizeSupplierProducts(fetched.products);
        const pageInvalidProducts = normalizedProducts.failed + Math.max(0, Number(fetched.invalidProducts || 0));
        metrics.productsDiscovered += fetched.products.length + Math.max(0, Number(fetched.invalidProducts || 0));
        metrics.productsFailed += pageInvalidProducts;
        sourceProductsDiscovered += fetched.products.length + Math.max(0, Number(fetched.invalidProducts || 0));
        sourceProductsFailed += pageInvalidProducts;
        let products = normalizedProducts.products.map((product) => ({
          ...product,
          mediaGallery: [...new Set((product.mediaGallery || []).filter(isValidSupplierImageUrl))].slice(0, imageLimit),
        }));
        collectDiscoveredSupplierCategories(products).forEach((category) => discoveredCategoryLabels.add(category));
        const allExistingProducts = await loadExistingProductsForSupplierBatch(products);
        for (const catalogProduct of products) {
          const existing = findMatchingProduct(catalogProduct, allExistingProducts);
          const belongsToSource = Boolean(existing && (
            existing.supplierSourceId === source.id
            || (!existing.supplierSourceId && existing.supplierId === (source.supplierId || source.id))
          ));
          if (existing && belongsToSource) {
            queuedWrites.push({
              collection: PRODUCT_PRIVATE_COLLECTION,
              id: existing.id,
              data: {
                supplierCatalogTraversalId: traversalCheckpoint.traversalId,
                supplierCatalogSeenAt: new Date().toISOString(),
              },
            });
          }
        }

        const categoryFilter = source.settings?.categoriesFilter || [];
        if (categoryFilter.length > 0) {
          products = products.filter((product) => matchesSupplierCategoryFilter(
            product.categoryHierarchy,
            categoryFilter,
            storeCategories,
            settings.categoryMappings,
          ));
        }

        const brandFilter = source.settings?.brandFilter || "";
        if (brandFilter) {
          const brands = brandFilter.split(",").map((brand) => brand.trim().toLowerCase()).filter(Boolean);
          products = products.filter((product) => {
            const brand = product.specifications?.brand || product.specifications?.Brand || "";
            return brands.some((expectedBrand) => product.title.toLowerCase().includes(expectedBrand) || brand.toLowerCase().includes(expectedBrand));
          });
        }

        const productsToProcess = products;
        const existingProducts = allExistingProducts;
        const queueCandidates = await loadSupplierQueueCandidates(productsToProcess);
        const activeReviewQueueDocs = queueCandidates.review.filter((queueDoc) => {
          const state = String(queueDoc.data().queueState || "").toLowerCase();
          const status = String(queueDoc.data().status || "").toLowerCase();
          return !["approved", "rejected"].includes(state) && !["approved", "rejected"].includes(status);
        });
        for (const queueDoc of [...activeReviewQueueDocs, ...queueCandidates.imported]) {
          existingQueueIds.add(queueDoc.id);
          const supplierCode = normalizeConflictValue(queueDoc.data().supplierCode || queueDoc.data().sku);
          if (supplierCode) queuedSupplierCodes.add(supplierCode);
        }
        activeReviewQueueDocs.forEach((queueDoc) => {
          const data = queueDoc.data();
          const sku = normalizeConflictValue(data.supplierCode);
          const candidate: SupplierSyncConflictWinner = {
            supplierId: String(data.supplierId || data.sourceId || "unknown"),
            sourceId: String(data.sourceId || "unknown"),
            priority: Number.isFinite(Number(data.supplierPriority)) ? Number(data.supplierPriority) : 10_000,
            queueItemId: queueDoc.id,
          };
          if (sku) {
            const existing = existingQueueWinnerBySku.get(sku);
            existingQueueWinnerBySku.set(sku, existing ? resolveSupplierPriority(existing, candidate) : candidate);
            winnerBySku.set(sku, existing ? resolveSupplierPriority(existing, candidate) : candidate);
          }
          const barcode = normalizeConflictValue(data.barcode);
          if (barcode) {
            const existing = winnerByBarcode.get(barcode);
            winnerByBarcode.set(barcode, existing ? resolveSupplierPriority(existing, candidate) : candidate);
          }
        });
        metrics.productsScanned += productsToProcess.length;
        metrics.suppliers.push(supplierName);
        appLogger.info("Scheduled supplier Product Limit resolved.", {
          event: "supplier_catalog_page_trace",
          batchId,
          sourceId: source.id,
          firestoreSourceValue: sourceSettings.productLimit ?? null,
          firestoreHubValue: settings.productLimit ?? null,
          scheduledMaxProducts: maxProducts,
          cursor: traversalCheckpoint.cursor,
          pageSize: productsToProcess.length,
          filteredCount: products.length,
          processedCount: productsToProcess.length,
        });

        for (const product of productsToProcess) {
          const queueItemId = generateQueueDocId(source.id, product.sku, product.title);
          const normalizedSupplierCode = product.sku.trim().toLowerCase();
          const currentWinner: SupplierSyncConflictWinner = {
            supplierId: source.supplierId || source.id,
            sourceId: source.id,
            priority: supplierPriority(source),
            queueItemId,
          };
          const supplierProductKey = `${source.id}:${normalizedSupplierCode}`;
          const priorSupplierProduct = seenSupplierProducts.get(supplierProductKey);
          const skuWinner = winnerBySku.get(normalizedSupplierCode);
          const normalizedBarcode = normalizeConflictValue(product.barcode);
          const barcodeWinner = normalizedBarcode ? winnerByBarcode.get(normalizedBarcode) : undefined;
          const match = findMatchingProduct(product, existingProducts);
          const conflict = priorSupplierProduct
            ? { reason: "duplicate_supplier_product" as const, winner: priorSupplierProduct }
            : skuWinner
              ? { reason: skuWinner.sourceId === source.id ? "duplicate_supplier_product" as const : "duplicate_sku" as const, winner: skuWinner }
              : barcodeWinner
                ? { reason: "duplicate_barcode" as const, winner: barcodeWinner }
                : null;
          if (conflict || existingQueueIds.has(queueItemId) || queuedSupplierCodes.has(normalizedSupplierCode)) {
            const winner = conflict?.winner || skuWinner || currentWinner;
            const reason = conflict?.reason || "duplicate_supplier_product" as const;
            const record = buildSupplierConflictRecord(source, product, winner, reason, batchId);
            queuedWrites.push({ collection: "supplier_product_conflicts", id: record.id, data: record.data });
            metrics.productsSkipped += 1;
            sourceRejected += 1;
            continue;
          }
          seenSupplierProducts.set(supplierProductKey, currentWinner);
          winnerBySku.set(normalizedSupplierCode, currentWinner);
          if (normalizedBarcode) winnerByBarcode.set(normalizedBarcode, currentWinner);
          const comparison = filterSupplierComparison(compareProduct(product, match), sourceSettings);
          if (!comparison) {
            metrics.productsSkipped += 1;
            continue;
          }
          const supplierBrand = String(product.brand || product.specifications?.brand || product.specifications?.Brand || "").trim();
          const supplierKeywords = product.keywords || String(product.specifications?.keywords || product.specifications?.Keywords || "")
            .split(/[,|]/gu)
            .map((keyword) => keyword.trim())
            .filter(Boolean);
          const productType = String(product.productType || product.specifications?.productType || product.specifications?.["Product Type"] || "").trim();
          const categoryMapping = suggestSupplierCategory({
            sourceId: source.id,
            supplierCategories: product.categoryHierarchy || [],
            productTitle: product.title,
            keywords: supplierKeywords,
            productType,
            categories: storeCategories,
            mappings: categoryMappingRecords,
          });
          const brandMapping = suggestSupplierBrand({
            sourceId: source.id,
            supplierBrand,
            brands: storeBrands,
            mappings: storedMappings.brandMappings,
          });
          const productPayload = buildProductPayload(product, match, categoryMapping, brandMapping, storeBrands, comparison, settings, source);
          const productValidationErrors = validateSupplierProductForApproval(productPayload, storeCategories, storeBrands);
          const productImportWarnings = buildSupplierImportWarnings(product, productPayload);
          const createdAt = new Date().toISOString();
          const supplierSnapshot = {
            ...product,
            supplierId: source.supplierId || source.id,
            sourceId: source.id,
            supplierPriority: supplierPriority(source),
            supplierName,
            supplierSku: product.sku,
            barcode: product.barcode || "",
            productName: product.title,
            description: product.longDescription || "",
            wholesalePrice: product.wholesalePrice,
            recommendedRetailPrice: product.recommendedRetailPrice,
            stock: product.inventoryLevel,
            imageUrls: [...(product.mediaGallery || [])],
            categoryHierarchy: [...(product.categoryHierarchy || [])],
            specifications: { ...(product.specifications || {}) },
            supplierMetadata: productPayload.supplierMetadata,
          };
          const queueItem = {
            id: queueItemId,
            status: "Pending",
            supplierCode: product.sku,
            supplierName,
            source: "Website",
            connector: String(source.supplierType || source.type || "website"),
            sourceId: source.id,
            supplierId: source.supplierId || source.id,
            supplierPriority: supplierPriority(source),
            batchId,
            productName: product.title,
            costPrice: product.wholesalePrice,
            marketPrice: product.recommendedRetailPrice,
            stock: product.inventoryLevel,
            barcode: product.barcode || "",
            imageUrl: product.mediaGallery?.[0],
            comparisonStatus: comparison.status,
            comparison: {
              matchFound: !!match,
              matchedProductId: match?.id || null,
              comparisonStatus: comparison.status,
              changedFields: comparison.changedFields,
            },
            productPayload,
            managedMedia: Array.isArray(productPayload.supplierMedia) ? productPayload.supplierMedia : [],
            supplierSnapshot,
            categoryMapping,
            brandMapping,
            productValidation: {
              readyToPublish: productValidationErrors.length === 0,
              missingFields: [...new Set(productValidationErrors.map((error) => error.field))],
              errors: productValidationErrors,
              warnings: productImportWarnings,
            },
            matchedProductId: match?.id || null,
            approvalBaseline: buildSupplierProductApprovalBaseline(
              String(productPayload.id),
              match ? { ...match } : undefined,
              createdAt,
            ),
            createdAt,
            updatedAt: createdAt,
          };

          if (dryRunMode) {
            dryRunComparisonCount++;
          } else {
            const pendingChange = buildPendingChange(queueItem, product, match, comparison.status);
            const queueData = {
              ...queueItem,
              ...buildSupplierQueueLifecycle(createdAt),
              correlationId: queueItemId,
              importPayload: {
                ...product,
                id: queueItemId,
                supplierCode: product.sku,
                supplierName,
                source: "Website",
                sourceId: source.id,
                batchId,
                importStatus: "Pending",
                progress: 0,
                createdAt,
                updatedAt: createdAt,
              },
              ...(pendingChange ? { pendingChangePayload: pendingChange } : {}),
            };
            queuedWrites.push({
              collection: "supplier_review_queue",
              id: queueItemId,
              data: queueData,
              atomicGroup: queueItemId,
            });
            const auditReference = adminDb.collection("supplier_approval_audit").doc();
            queuedWrites.push({
              collection: "supplier_approval_audit",
              id: auditReference.id,
              create: true,
              atomicGroup: queueItemId,
              data: buildSupplierAuditEvent({
                queueItemId,
                queueItem: queueData,
                action: "queued",
                previousState: null,
                newState: "queued",
              }, auditReference.id),
            });
            stagedReviewQueueIds.push(queueItemId);
            existingQueueIds.add(queueItemId);
            queuedSupplierCodes.add(normalizedSupplierCode);
            metrics.productsQueued++;
            if (comparison.status === "NEW_PRODUCT") metrics.productsImported++;
            else metrics.productsUpdated++;
          }
        }

            sourceQueueDepth += activeReviewQueueDocs.filter((queueDoc) => queueDoc.data().sourceId === source.id).length;
            const pageWrites = queuedWrites.splice(pageWriteOffset);
            const pageQueueItemIds = stagedReviewQueueIds.splice(pageStagedOffset);
            if (!dryRunMode) {
              await commitQueuedItems(pageWrites);
              const pageQueueResults = await processSupplierQueueItemsBounded(pageQueueItemIds, queueWorkerId);
              for (const result of pageQueueResults) {
                if (result.outcome === "retryable_failure" || result.outcome === "dead_letter") {
                  metrics.retryCount += 1;
                  metrics.errors.push(`Supplier review queue item ${result.queueItemId} requires recovery.`);
                }
              }
            }
            if (pageInvalidProducts > 0) {
              throw new Error(`Supplier catalog page contained ${pageInvalidProducts} invalid product record(s); traversal checkpoint and deletion reconciliation were withheld.`);
            }
            const pageImported = metrics.productsQueued - queuedBeforePage;
            appLogger.info("Supplier catalog page committed.", {
              event: "supplier_catalog_page_committed",
              batchId,
              sourceId: source.id,
              traversalId: traversalCheckpoint.traversalId,
              cursor: traversalCheckpoint.cursor,
              productsScanned: productsToProcess.length,
              productsQueued: pageImported,
            });
            return { productsScanned: productsToProcess.length, productsImported: pageImported };
          },
        });

        const sourceFinishedAt = Date.now();
        metrics.pagesProcessed += Math.max(0, traversalResult.checkpoint.pagesProcessed - initialTraversalPages);
        metrics.resumeCount += Math.max(0, traversalResult.checkpoint.resumeCount - initialResumeCount);
        metrics.sourceCursors[source.id] = traversalResult.checkpoint.cursor;
        if (traversalResult.complete) {
          metrics.lastCompletedTraversals[source.id] = traversalResult.checkpoint.traversalId;
        }
        if (!traversalResult.complete) incompleteTraversalCount += 1;
        if (!dryRunMode) {
          await adminDb.collection("supplierSources").doc(source.id).set({
            lastSync: new Date(sourceFinishedAt).toISOString(),
            ...(traversalResult.complete ? {
              lastSuccessfulSyncAt: new Date(sourceFinishedAt).toISOString(),
              syncCompletedAt: new Date(sourceFinishedAt).toISOString(),
            } : {
              lastPartialSyncAt: new Date(sourceFinishedAt).toISOString(),
            }),
            nextScheduledSyncAt: getNextSupplierSourceSyncIso(sourceSettings.autoSync, sourceFinishedAt),
            currentlySyncing: false,
            syncLeaseExpiresAt: FieldValue.delete(),
            connectionStatus: traversalResult.complete ? "connected" : "Partial",
            lastError: traversalResult.complete ? "None" : "Catalog traversal paused and will resume from its persisted cursor.",
            syncMetrics: {
              pagesProcessed: traversalResult.checkpoint.pagesProcessed,
              productsDiscovered: sourceProductsDiscovered,
              productsScanned: traversalResult.checkpoint.productsScanned,
              productsImported: traversalResult.checkpoint.productsImported,
              productsRejected: sourceRejected,
              productsFailed: sourceProductsFailed,
              retries: traversalResult.checkpoint.resumeCount,
              resumeCount: traversalResult.checkpoint.resumeCount,
              cursor: traversalResult.checkpoint.cursor,
              queueDepth: sourceQueueDepth + traversalResult.checkpoint.productsImported,
              durationMs: Math.max(0, sourceFinishedAt - sourceStartedAt),
              lastCompletedTraversal: traversalResult.complete ? traversalResult.checkpoint.traversalId : null,
              updatedAt: new Date(sourceFinishedAt).toISOString(),
            },
            syncHealth: traversalResult.complete
              ? buildSupplierHealth(
                source.syncHealth || {},
                "success",
                Math.max(0, sourceFinishedAt - sourceStartedAt),
                new Date(sourceFinishedAt).toISOString(),
              )
              : source.syncHealth || {},
            settings: {
              ...sourceSettings,
              discoveredCategories: [...discoveredCategoryLabels].sort((left, right) => left.localeCompare(right)),
            },
          }, { merge: true });
        }
      } catch (error: any) {
        queuedWrites.splice(sourceWriteOffset);
        stagedReviewQueueIds.splice(sourceStagedOffset);
        const message = error?.message || "Unknown supplier sync error";
        const failureClassification = classifySupplierQueueFailure(error);
        metrics.errors.push(`${supplierName}: [${failureClassification}] ${message}`);
        metrics.sourceFailures += 1;
        if (sourceProductsFailed === 0) metrics.productsFailed += 1;
        appLogger.error("Scheduled supplier source sync failed.", {
          batchId,
          sourceId: source.id,
          supplierName,
          failureClassification,
          error,
        });
        if (source.settings?.dryRunMode !== true) {
          await adminDb.collection("supplierSources").doc(source.id).set({
            connectionStatus: "Failed",
            lastError: message,
            lastFailureClassification: failureClassification,
            lastFailedSyncAt: new Date().toISOString(),
            nextScheduledSyncAt: getNextSupplierSourceSyncIso(sourceSettings.autoSync, Date.now()),
            currentlySyncing: false,
            syncLeaseExpiresAt: FieldValue.delete(),
            syncMetrics: {
              productsDiscovered: sourceProductsDiscovered,
              productsImported: 0,
              productsRejected: 0,
              productsFailed: Math.max(1, sourceProductsFailed),
              retries: Number(source.syncMetrics?.retries || 0) + 1,
              queueDepth: 0,
              durationMs: Math.max(0, Date.now() - sourceStartedAt),
              updatedAt: new Date().toISOString(),
            },
            syncHealth: buildSupplierHealth(source.syncHealth || {}, "failure", Math.max(0, Date.now() - sourceStartedAt), new Date().toISOString()),
          }, { merge: true });
        }
        // A single connector failure must not prevent remaining suppliers from syncing.
        continue;
      }
    }

    if (nonDrySourceCount === 0) {
      const finishedAt = new Date();
      await writeHistory(batchId, trigger, "Success", startedAt, finishedAt, metrics, "Supplier dry run completed without queue writes.");
      appLogger.info("Scheduled supplier dry run completed without database queue writes.", {
        batchId,
        productsScanned: metrics.productsScanned,
        comparisons: dryRunComparisonCount,
      });
      return buildRunResult(batchId, "Success", metrics);
    }

    await commitQueuedItems(queuedWrites);
    const stagedResults = await Promise.all(stagedReviewQueueIds.map((queueItemId) => (
      processSupplierReviewQueueItem(adminDb, queueItemId, queueWorkerId)
    )));
    const failedStagedItems = stagedResults.filter((result) => result.outcome === "retryable_failure" || result.outcome === "dead_letter");
    if (failedStagedItems.length > 0) {
      metrics.errors.push(`${failedStagedItems.length} supplier review queue item(s) require recovery.`);
      metrics.retryCount += failedStagedItems.length;
    }
    const finishedAt = new Date();
    await releaseSourceSyncLeases(sources.filter((source) => source.settings?.dryRunMode !== true), batchId, finishedAt.getTime());
    const status: SyncStatus = incompleteTraversalCount > 0
      ? "Partial"
      : metrics.errors.length === 0
        ? "Success"
        : (metrics.productsQueued > 0 ? "Partial" : "Failed");
    const nextSync = getNextSyncIso(settings, finishedAt.getTime());

    await adminDb.collection("supplier_settings").doc("config").set({
      lastSync: finishedAt.toISOString(),
      nextSync,
      schedulerLastStatus: status,
      schedulerLastRunBatchId: batchId,
      schedulerLastRunFinishedAt: finishedAt.toISOString(),
      schedulerLastRunStartedAt: startedAt.toISOString(),
      schedulerLastRunMetrics: {
        productsDiscovered: metrics.productsDiscovered,
        productsScanned: metrics.productsScanned,
        productsQueued: metrics.productsQueued,
        productsImported: metrics.productsImported,
        productsUpdated: metrics.productsUpdated,
        productsDeleted: metrics.productsDeleted,
        productsSkipped: metrics.productsSkipped,
        productsFailed: metrics.productsFailed,
        retryCount: metrics.retryCount,
        sourceFailures: metrics.sourceFailures,
        pagesProcessed: metrics.pagesProcessed,
        resumeCount: metrics.resumeCount,
        sourceCursors: metrics.sourceCursors,
        lastCompletedTraversals: metrics.lastCompletedTraversals,
        elapsedTimeMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      },
      schedulerStatus: "idle",
      schedulerActiveSyncCount: 0,
      schedulerSchedule: SUPPLIER_SCHEDULER_SCHEDULE,
    }, { merge: true });

    await writeHistory(
      batchId,
      trigger,
      status,
      startedAt,
      finishedAt,
      metrics,
      `${trigger} supplier sync discovered ${metrics.productsDiscovered} products, scanned ${metrics.productsScanned}, queued ${metrics.productsQueued}, and skipped ${metrics.productsSkipped}.`
    );

    appLogger.info("Scheduled supplier sync finished.", {
      batchId,
      status,
      productsScanned: metrics.productsScanned,
      productsQueued: metrics.productsQueued,
      errorCount: metrics.errors.length,
    });
    return buildRunResult(batchId, status, metrics);
  } catch (error: any) {
    const finishedAt = new Date();
    metrics.errors.push(error?.message || "Unknown scheduled sync failure");
    appLogger.error("Scheduled supplier sync failed.", {
      batchId,
      productsScanned: metrics.productsScanned,
      productsQueued: metrics.productsQueued,
      error,
    });
    if (hasWritableSources) {
      await writeHistory(batchId, trigger, "Failed", startedAt, finishedAt, metrics, error?.message || "Scheduled sync failed.");
      await clearInterruptedSourceSyncMarkers(sources, batchId, error?.message || "Supplier sync interrupted.");
      await adminDb.collection("supplier_settings").doc("config").set({
        schedulerStatus: "failed",
        schedulerActiveSyncCount: 0,
        schedulerLastStatus: "Failed",
        schedulerLastRunBatchId: batchId,
        schedulerLastRunFinishedAt: finishedAt.toISOString(),
      }, { merge: true });
    }
    throw error;
  } finally {
    if (syncLockAcquired) await releaseSyncLock(new Date());
  }
}

export async function runScheduledSupplierSync(): Promise<void> {
  await runSupplierSync({ trigger: "scheduled" });
}

/** Admin-facing operational snapshot. It reads existing run/source metadata only. */
export async function getSupplierSyncSchedulerStatus(): Promise<Record<string, unknown>> {
  const [settingsSnapshot, lockSnapshot, historySnapshot, activeSourcesCount] = await Promise.all([
    adminDb.collection("supplier_settings").doc("config").get(),
    adminDb.collection("supplier_sync_locks").doc(LOCK_ID).get(),
    adminDb.collection("supplier_sync_history").orderBy("createdAt", "desc").limit(1).get(),
    adminDb.collection("supplierSources").where("currentlySyncing", "==", true).count().get(),
  ]);
  const settings = settingsSnapshot.data() || {};
  const lock = lockSnapshot.data() || {};
  const lastRun = historySnapshot.docs[0];
  return {
    schedule: SUPPLIER_SCHEDULER_SCHEDULE,
    status: settings.schedulerStatus || lock.status || "idle",
    activeSyncCount: Number(lock.activeSyncCount || 0),
    activeSourceCount: activeSourcesCount.data().count,
    currentBatchId: settings.schedulerCurrentBatchId || lock.owner || null,
    currentTrigger: settings.schedulerCurrentTrigger || lock.trigger || null,
    previousRun: lastRun ? { id: lastRun.id, ...lastRun.data() } : null,
    nextPlannedExecution: settings.nextSync || null,
    schedulerLastRunMetrics: settings.schedulerLastRunMetrics || null,
    queueMetrics: settings.queueMetrics || null,
    queueWorkerStatus: settings.queueWorkerStatus || "idle",
    queueWorkerLastRun: settings.queueWorkerLastRun || null,
  };
}

export const scheduledSupplierSync = onSchedule({
  schedule: SUPPLIER_SCHEDULER_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: A2Z_SECRETS,
}, async () => {
  await runScheduledSupplierSync();
});
