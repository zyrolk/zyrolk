import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { A2Z_SECRETS } from "../config/secrets";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { SupplierRegistry } from "../api/suppliers/SupplierRegistry";
import { isValidSupplierImageUrl, ProductParser } from "../api/suppliers/a2z/ProductParser";
import { RawA2ZProduct } from "../api/suppliers/a2z/types";
import { matchesSupplierCategoryFilter, resolveSupplierCategory, StoreCategoryReference, SupplierCategoryMappings } from "./supplierCategoryMapping";
import {
  collectDiscoveredSupplierCategories,
  filterSupplierComparison,
  getSupplierProductLimit,
  isSupplierSourceAutoSyncDue,
  SupplierSourceSyncSettings,
} from "./supplierSyncSettings";

type SyncStatus = "Success" | "Failed" | "Partial" | "Skipped";
type ComparisonStatus = "NEW_PRODUCT" | "PRICE_CHANGED" | "STOCK_CHANGED" | "DESCRIPTION_CHANGED" | "IMAGE_CHANGED" | "UNCHANGED";

interface SupplierSettings {
  autoSyncEnabled?: boolean;
  syncInterval?: string;
  lastSync?: string;
  nextSync?: string;
  maxProducts?: number;
  defaultImageLimit?: number;
  enabledSupplierIds?: string[];
  enabledSuppliers?: string[];
  categoryMappings?: SupplierCategoryMappings;
}

interface SupplierSource {
  id: string;
  supplierName?: string;
  name?: string;
  supplierType?: string;
  type?: string;
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
}

interface SyncMetrics {
  productsScanned: number;
  productsQueued: number;
  errors: string[];
  suppliers: string[];
}

const LOCK_ID = "scheduled_supplier_sync";
const LOCK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PRODUCTS = 5;

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

function getMaxProducts(settings: SupplierSettings): number {
  const configured = Number(settings.maxProducts || settings.defaultImageLimit || DEFAULT_MAX_PRODUCTS);
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_PRODUCTS;
  }
  return Math.min(Math.floor(configured), 250);
}

function isSourceEnabled(source: SupplierSource, settings: SupplierSettings): boolean {
  const enabledIds = settings.enabledSupplierIds || settings.enabledSuppliers || [];
  const type = source.supplierType || source.type || "website";
  const isActiveWebsite = source.sourceStatus === "active" && type.toLowerCase() === "website";
  return isActiveWebsite && (enabledIds.length === 0 || enabledIds.includes(source.id));
}

function normalizeSupplierProducts(products: any[]): RawA2ZProduct[] {
  const normalized: RawA2ZProduct[] = [];

  for (const product of products) {
    try {
      normalized.push(ProductParser.parseJsonPayload(product));
    } catch (error) {
      logger.warn("Skipping malformed supplier product during scheduled sync.", { error });
    }
  }

  return normalized;
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

  const supplierImage = product.mediaGallery?.[0] || "";
  if (supplierImage !== (match.imageUrl || "")) changedFields.push("Primary Image");

  if (changedFields.length === 0) return { status: "UNCHANGED", changedFields };
  if (changedFields.includes("Cost Price") || changedFields.includes("Market Price")) return { status: "PRICE_CHANGED", changedFields };
  if (changedFields.includes("Stock")) return { status: "STOCK_CHANGED", changedFields };
  if (changedFields.includes("Primary Image")) return { status: "IMAGE_CHANGED", changedFields };
  return { status: "DESCRIPTION_CHANGED", changedFields };
}

function buildProductPayload(
  product: RawA2ZProduct,
  match: ExistingProduct | undefined,
  storeCategories: readonly StoreCategoryReference[],
  categoryMappings: SupplierCategoryMappings | undefined,
  comparison: { status: ComparisonStatus; changedFields: string[] },
): Record<string, unknown> {
  const docId = match ? match.id : (generateSlug(product.title) || product.sku);
  const wholesale = product.wholesalePrice || 0;
  const retail = product.recommendedRetailPrice || wholesale * 1.15;
  const price = Math.round(retail);
  const originalPrice = Math.round(retail * 1.1);
  const imageUrls = [...new Set((product.mediaGallery || []).filter(isValidSupplierImageUrl).map((url) => url.trim()))];
  const supplierImageUrl = imageUrls[0] || "";
  const resolvedCategory = resolveSupplierCategory(product.categoryHierarchy, storeCategories, categoryMappings);
  const isNewProduct = !match;
  const priceUpdateEnabled = isNewProduct || comparison.changedFields.some((field) => field === "Cost Price" || field === "Market Price");
  const stockUpdateEnabled = isNewProduct || comparison.changedFields.includes("Stock");
  const descriptionUpdateEnabled = isNewProduct || comparison.changedFields.some((field) => field === "Product Name" || field === "Description");
  const imageUpdateEnabled = isNewProduct || comparison.changedFields.includes("Primary Image");
  const imageUrl = imageUpdateEnabled ? supplierImageUrl : (match?.imageUrl || "");
  const effectiveImageUrls = imageUpdateEnabled ? imageUrls : (match?.imageUrls || (imageUrl ? [imageUrl] : []));

  return {
    id: docId,
    name: descriptionUpdateEnabled ? product.title : (match?.name || product.title),
    description: descriptionUpdateEnabled ? (product.longDescription || "") : (match?.description || ""),
    price: priceUpdateEnabled ? price : (match?.price || price),
    originalPrice: priceUpdateEnabled ? originalPrice : (match?.originalPrice || match?.price || originalPrice),
    discount: priceUpdateEnabled ? 10 : (match?.discount || 0),
    stock: stockUpdateEnabled ? product.inventoryLevel : (match?.stock || 0),
    imageUrl,
    imageUrls: effectiveImageUrls,
    category: isNewProduct ? resolvedCategory : (match?.category || resolvedCategory),
    specs: descriptionUpdateEnabled ? (product.specifications || {}) : (match?.specs || {}),
    isNew: isNewProduct ? true : match?.isNew === true,
    isFeatured: isNewProduct ? false : match?.isFeatured === true,
    isBestSeller: isNewProduct ? false : match?.isBestSeller === true,
    isActive: isNewProduct ? true : match?.isActive !== false,
    active: isNewProduct ? true : match?.active !== false,
    published: isNewProduct ? true : match?.published !== false,
    approved: isNewProduct ? true : match?.approved !== false,
    visible: isNewProduct ? true : match?.visible !== false,
    sku: product.sku,
    supplierItemCode: product.sku,
    costPrice: priceUpdateEnabled ? wholesale : (match?.costPrice || 0),
    marketPrice: priceUpdateEnabled ? (product.recommendedRetailPrice || 0) : (match?.marketPrice || 0),
    rating: match?.rating ?? 5,
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
  };
}

async function acquireSyncLock(startedAt: Date): Promise<boolean> {
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
      owner: LOCK_ID,
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
    finishedAt: finishedAt.toISOString(),
    updatedAt: finishedAt.toISOString(),
  }, { merge: true });
}

async function writeHistory(
  batchId: string,
  status: SyncStatus,
  startedAt: Date,
  finishedAt: Date,
  metrics: SyncMetrics,
  details: string,
): Promise<void> {
  await adminDb.collection("supplier_sync_history").doc(batchId).set({
    id: batchId,
    batchId,
    trigger: "scheduled",
    timestamp: finishedAt.toLocaleTimeString("en-US", { timeZone: "Asia/Colombo" }),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    supplier: metrics.suppliers.join(", ") || "Scheduled Supplier Sync",
    supplierCode: metrics.suppliers.join(", ") || "Scheduled",
    status,
    productsScanned: metrics.productsScanned,
    productsQueued: metrics.productsQueued,
    productsSynced: metrics.productsScanned,
    errors: metrics.errors,
    details,
    createdAt: finishedAt.toISOString(),
  }, { merge: true });
}

async function commitQueuedItems(items: Array<{ collection: string; id: string; data: Record<string, unknown> }>): Promise<void> {
  let batch = adminDb.batch();
  let operationCount = 0;

  for (const item of items) {
    batch.set(adminDb.collection(item.collection).doc(item.id), item.data, { merge: true });
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

export async function runScheduledSupplierSync(): Promise<void> {
  const startedAt = new Date();
  const batchId = `scheduled-${startedAt.getTime()}`;
  const metrics: SyncMetrics = {
    productsScanned: 0,
    productsQueued: 0,
    errors: [],
    suppliers: [],
  };

  const settingsSnap = await adminDb.collection("supplier_settings").doc("config").get();
  const settings = (settingsSnap.exists ? settingsSnap.data() : {}) as SupplierSettings;

  appLogger.info("Scheduled supplier sync evaluated.", {
    batchId,
    autoSyncEnabled: !!settings.autoSyncEnabled,
    syncInterval: settings.syncInterval || "unspecified",
  });

  if (!isSyncDue(settings, startedAt.getTime())) {
    appLogger.info("Scheduled supplier sync skipped because it is not due.", { batchId });
    return;
  }

  const lockAcquired = await acquireSyncLock(startedAt);
  if (!lockAcquired) {
    const finishedAt = new Date();
    await writeHistory(batchId, "Skipped", startedAt, finishedAt, metrics, "Scheduled sync skipped because another supplier sync is already running.");
    appLogger.warn("Scheduled supplier sync skipped because lock is already held.", { batchId });
    return;
  }

  try {
    appLogger.info("Scheduled supplier sync started.", { batchId });

    const existingSnap = await adminDb.collection("products").get();
    const existingProducts = existingSnap.docs.map((productDoc) => ({
      id: productDoc.id,
      ...productDoc.data(),
    })) as ExistingProduct[];

    const categoriesSnap = await adminDb.collection("categories").get();
    const storeCategories = categoriesSnap.docs.map((categoryDoc) => ({
      id: categoryDoc.id,
      name: String(categoryDoc.data().name || categoryDoc.id),
    }));

    const sourcesSnap = await adminDb.collection("supplierSources").get();
    const sources = sourcesSnap.docs
      .map((sourceDoc) => ({ id: sourceDoc.id, ...sourceDoc.data() }) as SupplierSource)
      .filter((source) => isSourceEnabled(source, settings))
      .filter((source) => isSupplierSourceAutoSyncDue(source.settings?.autoSync, source.lastSync, startedAt.getTime()));

    if (sources.length === 0) {
      appLogger.info("Scheduled supplier sync found no enabled sources due for synchronization.", { batchId });
      return;
    }

    const maxProducts = getMaxProducts(settings);
    const connectors = await SupplierRegistry.loadEnabledConnectors(settings.enabledSupplierIds || settings.enabledSuppliers || []);
    const connectorBySourceId = new Map(connectors.map((connector) => [connector.id, connector]));
    const queuedWrites: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
    let dryRunComparisonCount = 0;
    let nonDrySourceCount = 0;

    for (const source of sources) {
      const supplierName = source.supplierName || source.name || source.id;
      const websiteUrl = source.websiteUrl || source.config?.targetUrl || "";
      const endpoint = source.endpoint || source.config?.apiEndpoint || "";
      const sourceSettings = source.settings || {};
      const dryRunMode = sourceSettings.dryRunMode === true;
      if (!dryRunMode) nonDrySourceCount++;

      if (!websiteUrl) {
        metrics.errors.push(`${supplierName}: missing website URL`);
        continue;
      }

      try {
        const connector = connectorBySourceId.get(source.id) ||
          await SupplierRegistry.createConnectorForTarget(websiteUrl, endpoint, {
            id: source.id,
            name: supplierName,
            enabled: true,
          });
        const fetched = await connector.fetchProducts();
        let products = normalizeSupplierProducts(fetched.products);
        const discoveredCategories = collectDiscoveredSupplierCategories(products);

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

        const sourceLimit = getSupplierProductLimit(sourceSettings.productLimit, maxProducts);
        const productsToProcess = products.slice(0, sourceLimit);
        metrics.productsScanned += productsToProcess.length;
        metrics.suppliers.push(supplierName);

        for (const product of productsToProcess) {
          const match = findMatchingProduct(product, existingProducts);
          const comparison = filterSupplierComparison(compareProduct(product, match), sourceSettings);
          if (!comparison) continue;
          const queueItemId = generateQueueDocId(source.id, product.sku, product.title);
          const productPayload = buildProductPayload(product, match, storeCategories, settings.categoryMappings, comparison);
          const createdAt = new Date().toISOString();
          const supplierSnapshot = {
            supplierName,
            supplierSku: product.sku,
            productName: product.title,
            description: product.longDescription || "",
            wholesalePrice: product.wholesalePrice,
            recommendedRetailPrice: product.recommendedRetailPrice,
            stock: product.inventoryLevel,
            imageUrls: [...(product.mediaGallery || [])],
            categoryHierarchy: [...(product.categoryHierarchy || [])],
            specifications: { ...(product.specifications || {}) },
          };
          const queueItem = {
            id: queueItemId,
            status: "Pending",
            supplierCode: product.sku,
            supplierName,
            source: "Website",
            sourceId: source.id,
            batchId,
            productName: product.title,
            costPrice: product.wholesalePrice,
            marketPrice: product.recommendedRetailPrice,
            stock: product.inventoryLevel,
            imageUrl: product.mediaGallery?.[0],
            comparisonStatus: comparison.status,
            comparison: {
              matchFound: !!match,
              matchedProductId: match?.id || null,
              comparisonStatus: comparison.status,
              changedFields: comparison.changedFields,
            },
            productPayload,
            supplierSnapshot,
            matchedProductId: match?.id || null,
            createdAt,
            updatedAt: createdAt,
          };

          if (dryRunMode) {
            dryRunComparisonCount++;
          } else {
            queuedWrites.push({ collection: "supplier_review_queue", id: queueItemId, data: queueItem });
            queuedWrites.push({
              collection: "supplier_import_queue",
              id: queueItemId,
              data: {
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
            });

            const pendingChange = buildPendingChange(queueItem, product, match, comparison.status);
            if (pendingChange) {
              queuedWrites.push({ collection: "supplier_pending_changes", id: String(pendingChange.id), data: pendingChange });
            }
            metrics.productsQueued++;
          }
        }

        if (!dryRunMode) {
          await adminDb.collection("supplierSources").doc(source.id).set({
            lastSync: new Date().toISOString(),
            connectionStatus: "connected",
            lastError: "None",
            settings: {
              ...sourceSettings,
              discoveredCategories,
            },
          }, { merge: true });
        }
      } catch (error: any) {
        const message = error?.message || "Unknown supplier sync error";
        metrics.errors.push(`${supplierName}: ${message}`);
        appLogger.error("Scheduled supplier source sync failed.", {
          batchId,
          sourceId: source.id,
          supplierName,
          error,
        });
        if (source.settings?.dryRunMode !== true) {
          await adminDb.collection("supplierSources").doc(source.id).set({
            connectionStatus: "Failed",
            lastError: message,
          }, { merge: true });
        }
      }
    }

    if (nonDrySourceCount === 0) {
      appLogger.info("Scheduled supplier dry run completed without database queue or history writes.", {
        batchId,
        productsScanned: metrics.productsScanned,
        comparisons: dryRunComparisonCount,
      });
      return;
    }

    await commitQueuedItems(queuedWrites);

    const finishedAt = new Date();
    const status: SyncStatus = metrics.errors.length === 0 ? "Success" : (metrics.productsQueued > 0 ? "Partial" : "Failed");
    const nextSync = getNextSyncIso(settings, finishedAt.getTime());

    await adminDb.collection("supplier_settings").doc("config").set({
      lastSync: finishedAt.toISOString(),
      nextSync,
      schedulerLastStatus: status,
      schedulerLastRunBatchId: batchId,
      schedulerLastRunFinishedAt: finishedAt.toISOString(),
    }, { merge: true });

    await writeHistory(
      batchId,
      status,
      startedAt,
      finishedAt,
      metrics,
      `Scheduled sync scanned ${metrics.productsScanned} products and queued ${metrics.productsQueued} products.`
    );

    appLogger.info("Scheduled supplier sync finished.", {
      batchId,
      status,
      productsScanned: metrics.productsScanned,
      productsQueued: metrics.productsQueued,
      errorCount: metrics.errors.length,
    });
  } catch (error: any) {
    const finishedAt = new Date();
    metrics.errors.push(error?.message || "Unknown scheduled sync failure");
    appLogger.error("Scheduled supplier sync failed.", {
      batchId,
      productsScanned: metrics.productsScanned,
      productsQueued: metrics.productsQueued,
      error,
    });
    await writeHistory(batchId, "Failed", startedAt, finishedAt, metrics, error?.message || "Scheduled sync failed.");
    throw error;
  } finally {
    await releaseSyncLock(new Date());
  }
}

export const scheduledSupplierSync = onSchedule({
  schedule: "every 15 minutes",
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "512MiB",
  secrets: A2Z_SECRETS,
}, async () => {
  await runScheduledSupplierSync();
});
