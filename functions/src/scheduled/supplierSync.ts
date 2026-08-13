import { createHash } from "node:crypto";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { COMMERCIAL_PRODUCT_FIELDS, mergeProductData, PRODUCT_PRIVATE_COLLECTION } from "../api/products/productCommercialData";
import { SupplierRegistry } from "../api/suppliers/SupplierRegistry";
import { isValidSupplierImageUrl, ProductParser } from "../api/suppliers/a2z/ProductParser";
import { RawA2ZProduct } from "../api/suppliers/a2z/types";
import { normalizeSupplierSourceConfig } from "../api/suppliers/supplierSourceCompatibility";
import { SupplierCatalogFilterRequest, SupplierConnector, SupplierSourceConfig } from "../api/suppliers/types";
import {
  accumulateSupplierProductComparison,
  buildSupplierImportWarnings,
  buildSupplierLifecycleFieldChange,
  buildSupplierProductComparison,
  mergeSupplierCatalogDetails,
  mergeSupplierProductMetadata,
  SupplierFieldChange,
  SupplierProductComparison,
  SupplierProductComparisonStatus,
} from "../api/suppliers/supplierProductImport";
import { buildSupplierAuditEvent } from "../api/suppliers/supplierAuditTrail";
import {
  recordSupplierOperationalAlertSafely,
  resolveSupplierOperationalAlertSafely,
} from "../api/suppliers/supplierOperationalAlerts";
import { buildSupplierProductApprovalBaseline } from "../api/suppliers/supplierApprovalConcurrency";
import { buildSupplierHealth, resolveSupplierPriority, SupplierPriorityCandidate } from "../api/suppliers/multiSupplier";
import { createSupplierSyncJob, SupplierSyncJobProgressInput } from "../api/suppliers/supplierSyncJobs";
import {
  fingerprintSupplierSyncRequest,
  normalizeSupplierSyncRequest,
  resolveSupplierIncrementalCatalogRequest,
  SupplierSyncRequest,
  supplierSyncRequestHasFilters,
} from "../api/suppliers/supplierSyncRequest";
import {
  buildSupplierOfferId,
  buildSupplierOfferObservationWrite,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  normalizeSupplierOfferIdentity,
  projectSupplierOfferForAdmin,
  SupplierProductOffer,
  SupplierOfferStateExpectation,
  supplierOfferStateExpectation,
  supplierOfferStateMatchesExpectation,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "../api/suppliers/supplierOfferEngine";
import {
  buildLegacySupplierReviewQueueId,
  canonicalSupplierReviewIdentity,
  getSupplierQueueIdentityCandidate,
  planSupplierReviewQueueIds,
  supplierReviewQueueRecordMatchesIdentity,
  SupplierReviewQueueIdentityInput,
} from "../api/suppliers/supplierQueueIdentity";
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
  getSupplierImageLimit,
  isSupplierSourceAutoSyncDue,
  resolveSupplierProductLimit,
  selectSupplierComparisonForReview,
  SupplierSourceSyncSettings,
} from "./supplierSyncSettings";
import {
  buildSupplierQueueLifecycle,
  classifySupplierQueueFailure,
} from "./supplierReviewQueue";
import {
  normalizeSupplierCatalogPageSize,
  normalizeSupplierTotalProductLimit,
  runSupplierCatalogTraversal,
  SupplierCatalogTraversalCheckpoint,
} from "./supplierCatalogTraversal";

type SyncStatus = "Success" | "Failed" | "Partial" | "Skipped";

interface SupplierSettings {
  /** Legacy fields are accepted for stored-document compatibility but are not scheduling authorities. */
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
  enabled?: boolean;
  operationalState?: string;
  supplierName?: string;
  name?: string;
  supplierType?: string;
  type?: string;
  connectorType?: string;
  supplierId?: string;
  supplierAccountId?: string;
  priority?: unknown;
  capabilities?: string[];
  authentication?: {
    mode?: string;
    secretRef?: string;
    credentialProfile?: string;
  };
  sourceStatus?: string;
  syncSchedule?: string;
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
  lastCompletedCatalogTraversal?: {
    startedAt?: unknown;
    completedAt?: unknown;
    deltaToken?: unknown;
  };
  lastCompletedIncrementalTraversal?: {
    startedAt?: unknown;
    completedAt?: unknown;
    deltaToken?: unknown;
  };
}

type SupplierSyncJobScopedSource = Pick<SupplierSource, "catalogSync">;

const TERMINAL_SUCCESSFUL_TRAVERSAL_STATES = new Set(["completed", "limited"]);

/**
 * A retry of the same durable job must not traverse a source whose catalogue
 * pages already committed successfully for that job. A different job ID never
 * inherits this decision, so scheduled and later manual jobs remain unchanged.
 */
export function isSupplierSourceTerminallySuccessfulForJob(
  source: SupplierSyncJobScopedSource,
  jobId: string,
): boolean {
  const expectedJobId = String(jobId || "").trim();
  const checkpointJobId = String(source.catalogSync?.syncJobId || "").trim();
  const checkpointStatus = String(source.catalogSync?.status || "").trim().toLowerCase();
  return Boolean(expectedJobId)
    && checkpointJobId === expectedJobId
    && TERMINAL_SUCCESSFUL_TRAVERSAL_STATES.has(checkpointStatus);
}

export function partitionSupplierSourcesForSyncJob<T extends SupplierSyncJobScopedSource>(
  sources: readonly T[],
  jobId: string,
): { terminalSuccessful: T[]; pending: T[] } {
  const terminalSuccessful: T[] = [];
  const pending: T[] = [];
  sources.forEach((source) => {
    (isSupplierSourceTerminallySuccessfulForJob(source, jobId) ? terminalSuccessful : pending).push(source);
  });
  return { terminalSuccessful, pending };
}

export function resolveSupplierSyncRunStatus(input: {
  completedSources: number;
  failedSources: number;
  incompleteSources: number;
  interrupted: boolean;
}): SyncStatus {
  if (input.interrupted || input.incompleteSources > 0) return "Partial";
  if (input.failedSources > 0) return input.completedSources > 0 ? "Partial" : "Failed";
  return "Success";
}

interface ExistingProduct {
  id: string;
  name?: string;
  description?: string;
  sku?: string;
  barcode?: string;
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
  supplierLeadTime?: unknown;
  supplierMoq?: unknown;
  supplierFieldOwnership?: Record<string, unknown>;
  supplierOfferSelection?: Record<string, unknown>;
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
  sourceTerminationReasons: Record<string, string>;
  limitedSourceIds: string[];
}

export interface SupplierSyncRunOptions {
  trigger?: "scheduled" | "manual";
  sourceIds?: string[];
  maxRuntimeMs?: number;
  batchId?: string;
  syncRequest?: SupplierSyncRequest;
  control?: {
    reportProgress(progress: SupplierSyncJobProgressInput): Promise<void>;
    shouldCancel(): boolean;
  };
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
  sourceTerminationReasons: Record<string, string>;
  limitedSourceIds: string[];
  syncRequest: SupplierSyncRequest;
  elapsedTimeMs: number;
  waitingRecommended?: boolean;
}

const LOCK_ID = "scheduled_supplier_sync";
const LOCK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PRODUCTS = 5;
const DEFAULT_SYNC_RUNTIME_BUDGET_MS = 7 * 60 * 1000;
const DEFAULT_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
/** Dispatcher cadence only; each supplier's configured interval remains authoritative. */
export const SUPPLIER_SCHEDULER_SCHEDULE = String(process.env.SUPPLIER_SYNC_SCHEDULE || "every 15 minutes").trim() || "every 15 minutes";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateQueueDocId(sourceId: string, supplierCode: string, productName: string): string {
  return buildLegacySupplierReviewQueueId({ sourceId, supplierCode, productName });
}

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number") return value;
  if (typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  return null;
}

function isSyncDue(settings: SupplierSettings): boolean {
  return settings.autoSyncEnabled !== false;
}

function getNextSyncIso(settings: SupplierSettings, finishedAtMs: number): string | null {
  return settings.autoSyncEnabled !== false
    ? new Date(finishedAtMs + DEFAULT_SCHEDULER_INTERVAL_MS).toISOString()
    : null;
}

export function getSupplierSourceSyncIntervalMs(autoSync: unknown): number | null {
  switch (String(autoSync || "Off").trim().toLowerCase()) {
    case "15 minutes": return 15 * 60 * 1000;
    case "30 minutes": return 30 * 60 * 1000;
    case "1 hour": return 60 * 60 * 1000;
    case "3 hours": return 3 * 60 * 60 * 1000;
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

/** `settings.autoSync` is canonical; `syncSchedule` is retained as a legacy read fallback. */
export const supplierSourceAutoSyncSchedule = (source: SupplierSource): string => {
  const configured = String(source.settings?.autoSync || "").trim();
  return configured || String(source.syncSchedule || "Off").trim() || "Off";
};

const supplierPriority = (source: SupplierSource): number => {
  const priority = Number(source.priority ?? source.settings?.priority ?? 100);
  return Number.isFinite(priority) ? Math.max(0, Math.min(Math.floor(priority), 10_000)) : 100;
};

const normalizeConflictValue = (value: unknown): string => String(value || "").trim().toLocaleLowerCase();

export const normalizeSupplierCatalogFilterValue = (value: unknown): string => String(value || "")
  .normalize("NFKC")
  .trim()
  .toLocaleLowerCase("en")
  .replace(/\s+/gu, " ");

export function matchesSupplierSubcategoryFilter(product: RawA2ZProduct, requestedSubcategory: unknown): boolean {
  const expected = normalizeSupplierCatalogFilterValue(requestedSubcategory);
  if (!expected) return true;
  const hierarchySubcategories = (product.categoryHierarchy || []).slice(1);
  return [product.supplierSubcategory, ...hierarchySubcategories]
    .some((candidate) => normalizeSupplierCatalogFilterValue(candidate) === expected);
}

export function matchesSupplierCatalogSearch(product: RawA2ZProduct, query: unknown): boolean {
  const expected = normalizeSupplierCatalogFilterValue(query);
  if (!expected) return true;
  const brand = product.brand || product.specifications?.brand || product.specifications?.Brand;
  return [product.title, product.supplierProductId, product.sku, product.barcode, brand]
    .some((candidate) => normalizeSupplierCatalogFilterValue(candidate).includes(expected));
}

function supplierSyncRequestFingerprint(
  request: SupplierSyncRequest,
  source: SupplierSource,
  effectivePageSize: number,
): string {
  const persistentCategories = [...(source.settings?.categoriesFilter || [])]
    .map(normalizeSupplierCatalogFilterValue)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({
    request: fingerprintSupplierSyncRequest(request),
    effectivePageSize,
    persistentCategories,
    persistentBrandFilter: normalizeSupplierCatalogFilterValue(source.settings?.brandFilter),
  })).digest("hex");
}

type SupplierFilterCapabilityKey = "categoryFilter" | "subcategoryFilter" | "searchFilter";

const requestedFilterEntries = (request: SupplierSyncRequest): Array<{
  requestKey: "category" | "subcategory" | "search";
  capabilityKey: SupplierFilterCapabilityKey;
  value: string;
}> => ([
  { requestKey: "category", capabilityKey: "categoryFilter", value: request.filters?.category || "" },
  { requestKey: "subcategory", capabilityKey: "subcategoryFilter", value: request.filters?.subcategory || "" },
  { requestKey: "search", capabilityKey: "searchFilter", value: request.filters?.search || "" },
].filter((entry) => Boolean(entry.value)) as Array<{
  requestKey: "category" | "subcategory" | "search";
  capabilityKey: SupplierFilterCapabilityKey;
  value: string;
}>);

export function assertSupplierSyncRequestSupported(
  connector: Pick<SupplierConnector, "syncCapabilities">,
  request: SupplierSyncRequest,
): void {
  if (request.mode === "incremental" && connector.syncCapabilities?.incremental.supported !== true) {
    throw new Error("This supplier connector does not support true incremental synchronization.");
  }
  requestedFilterEntries(request).forEach(({ capabilityKey, requestKey }) => {
    if (!connector.syncCapabilities || connector.syncCapabilities[capabilityKey] === "unsupported") {
      throw new Error(`This supplier connector does not support the requested ${requestKey} filter.`);
    }
  });
}

function nativeSupplierCatalogFilters(
  connector: Pick<SupplierConnector, "syncCapabilities">,
  request: SupplierSyncRequest,
): SupplierCatalogFilterRequest | undefined {
  const filters = Object.fromEntries(requestedFilterEntries(request)
    .filter(({ capabilityKey }) => connector.syncCapabilities?.[capabilityKey] === "supplier_native")
    .map(({ requestKey, value }) => [requestKey, value]));
  return Object.keys(filters).length > 0 ? filters : undefined;
}

export function applyServerSideSupplierCatalogFilters(
  products: readonly RawA2ZProduct[],
  connector: Pick<SupplierConnector, "syncCapabilities">,
  request: SupplierSyncRequest,
  storeCategories: readonly StoreCategoryMappingCandidate[],
  mappings: SupplierCategoryMappings | undefined,
): RawA2ZProduct[] {
  let selected = [...products];
  if (request.filters?.category && connector.syncCapabilities?.categoryFilter === "server_side") {
    selected = selected.filter((product) => matchesSupplierCategoryFilter(
      product.categoryHierarchy,
      [request.filters?.category || ""],
      storeCategories,
      mappings,
    ));
  }
  if (request.filters?.subcategory && connector.syncCapabilities?.subcategoryFilter === "server_side") {
    selected = selected.filter((product) => matchesSupplierSubcategoryFilter(product, request.filters?.subcategory));
  }
  if (request.filters?.search && connector.syncCapabilities?.searchFilter === "server_side") {
    selected = selected.filter((product) => matchesSupplierCatalogSearch(product, request.filters?.search));
  }
  return selected;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

function getMaxProducts(settings: SupplierSettings): number {
  const configured = Number(settings.maxProducts || DEFAULT_MAX_PRODUCTS);
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_PRODUCTS;
  }
  return Math.min(Math.floor(configured), 250);
}

export function isSupplierSourceEnabled(source: SupplierSource, _settings: SupplierSettings): boolean {
  const status = String(source.sourceStatus || "active").trim().toLowerCase();
  const connectorType = normalizeSupplierSourceConfig(source.id, source).connectorType;
  const connectorIsRegistered = SupplierRegistry.supportedConnectorTypes().includes(connectorType);
  return status === "active" && source.enabled !== false && Boolean(String(source.supplierAccountId || "").trim()) && connectorIsRegistered;
}

export function isSupplierSourceEligibleForSync(
  source: SupplierSource,
  settings: SupplierSettings,
  trigger: "scheduled" | "manual",
  nowMs: number,
): boolean {
  if (trigger === "manual") {
    const operationalState = String(source.operationalState || "").trim().toLowerCase();
    const status = String(source.sourceStatus || (source.enabled === false ? "inactive" : "active")).trim().toLowerCase();
    const manuallyAvailable = operationalState === "paused"
      || (operationalState !== "disabled" && source.enabled !== false && status === "active");
    const connectorType = normalizeSupplierSourceConfig(source.id, source).connectorType;
    return manuallyAvailable
      && Boolean(String(source.supplierAccountId || "").trim())
      && SupplierRegistry.supportedConnectorTypes().includes(connectorType);
  }

  return isSupplierSourceEnabled(source, settings)
    && isSupplierSourceAutoSyncDue(supplierSourceAutoSyncSchedule(source), sourceLastSuccessfulSync(source), nowMs);
}

export function selectSupplierSourcesForSync(
  sources: readonly SupplierSource[],
  requestedSourceIds: readonly string[],
  settings: SupplierSettings,
  trigger: "scheduled" | "manual",
  nowMs: number,
): SupplierSource[] {
  return sources
    .filter((source) => isSupplierSourceEligibleForSync(source, settings, trigger, nowMs))
    .filter((source) => requestedSourceIds.length === 0 || requestedSourceIds.includes(source.id));
}

export function projectSupplierSourceForConnector(
  source: SupplierSource,
  trigger: "scheduled" | "manual",
): SupplierSource {
  if (trigger !== "manual" || String(source.operationalState || "").trim().toLowerCase() !== "paused") {
    return source;
  }
  return { ...source, enabled: true, sourceStatus: "active" };
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

function findMatchingProduct(
  product: RawA2ZProduct,
  existingProducts: ExistingProduct[],
  sourceId: string,
  supplierId: string,
): ExistingProduct | undefined {
  return existingProducts.find((candidate) => {
    const supplierCode = product.sku.trim().toLowerCase();
    const sourceMatches = candidate.supplierSourceId === sourceId
      || (!candidate.supplierSourceId && candidate.supplierId === supplierId);
    return sourceMatches && candidate.supplierItemCode?.trim().toLowerCase() === supplierCode;
  });
}

const chunkValues = <T>(values: readonly T[], size = 30): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push([...values.slice(index, index + size)]);
  return chunks;
};

/** Loads only products that can match the supplier batch; it never scans the catalog. */
async function loadExistingProductsForSupplierBatch(
  products: readonly RawA2ZProduct[],
  offerCandidates: readonly SupplierProductOffer[] = [],
): Promise<ExistingProduct[]> {
  const supplierCodes = [...new Set(products.map((product) => product.sku.trim()).filter(Boolean))];
  const zyroSkuCandidates = [...new Set(supplierCodes.flatMap((code) => [code, code.toUpperCase()]))];
  const barcodes = [...new Set(products.map((product) => String(product.barcode || "").trim()).filter(Boolean))];
  const candidateIds = [...new Set([
    ...products.flatMap((product) => [product.sku.trim(), generateSlug(product.title)]),
    ...offerCandidates.map((offer) => offer.productId || ""),
  ].filter(Boolean))];
  const privateSnapshots = await Promise.all([
    ...chunkValues(supplierCodes).map((codes) => adminDb.collection(PRODUCT_PRIVATE_COLLECTION)
      .where("supplierItemCode", "in", codes)
      .get()),
    ...chunkValues(supplierCodes.map((code) => code.toLocaleLowerCase())).map((codes) => adminDb.collection(PRODUCT_PRIVATE_COLLECTION)
      .where("supplierItemCodeNormalized", "in", codes)
      .get()),
    ...chunkValues(zyroSkuCandidates).map((codes) => adminDb.collection(PRODUCT_PRIVATE_COLLECTION)
      .where("sku", "in", codes)
      .get()),
  ]);
  const publicIdentitySnapshots = await Promise.all([
    ...chunkValues(supplierCodes).map((codes) => adminDb.collection("products").where("sku", "in", codes).get()),
    ...chunkValues(barcodes).map((values) => adminDb.collection("products").where("barcode", "in", values).get()),
  ]);
  const productById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  publicIdentitySnapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => productById.set(document.id, document));
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

/** Exact supplier identity lookups replace review/import queue collection scans. */
async function loadSupplierQueueCandidates(
  sourceId: string,
  products: readonly RawA2ZProduct[],
): Promise<SupplierQueueCandidateSnapshot> {
  const supplierCodes = [...new Set(products.map((product) => product.sku.trim()).filter(Boolean))];
  const supplierOfferIds = [...new Set(products.map((product) => buildSupplierOfferId(
    sourceId,
    product.supplierProductId || product.sku,
    product.sku,
  )))];
  const reviewSnapshots = await Promise.all([
    ...chunkValues(supplierCodes).map((codes) => (
      adminDb.collection("supplier_review_queue").select("supplierCode", "barcode", "sourceId", "supplierId", "supplierPriority", "queueState", "status", "canonicalProductId", "productId", "matchedProductId", "supplierOfferId", "productPayload", "supplierSnapshot", "comparison", "comparisonStatus", "approvalBaseline", "reconciliationAction", "createdAt", "queueCreatedAt").where("supplierCode", "in", codes).limit(300).get()
    )),
    ...chunkValues(supplierOfferIds).map((offerIds) => (
      adminDb.collection("supplier_review_queue").select("supplierCode", "barcode", "sourceId", "supplierId", "supplierPriority", "queueState", "status", "canonicalProductId", "productId", "matchedProductId", "supplierOfferId", "productPayload", "supplierSnapshot", "comparison", "comparisonStatus", "approvalBaseline", "reconciliationAction", "createdAt", "queueCreatedAt").where("supplierOfferId", "in", offerIds).limit(300).get()
    )),
  ]);
  const importSnapshots = await Promise.all(chunkValues(supplierCodes).flatMap((codes) => [
    adminDb.collection("supplier_import_queue").select("supplierCode", "sku").where("supplierCode", "in", codes).limit(300).get(),
    adminDb.collection("supplier_import_queue").select("supplierCode", "sku").where("sku", "in", codes).limit(300).get(),
  ]));
  const reviewById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  reviewSnapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => reviewById.set(document.id, document));
  const importedById = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  importSnapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => importedById.set(document.id, document));
  const review = [...reviewById.values()];
  const imported = [...importedById.values()];
  return { review, imported };
}

const supplierReviewIdentityInput = (
  sourceId: string,
  product: RawA2ZProduct,
): SupplierReviewQueueIdentityInput => ({
  sourceId,
  supplierProductId: product.supplierProductId || product.sku,
  supplierCode: product.sku,
  productName: product.title,
});

async function loadSupplierReviewQueueRecords(ids: readonly string[]): Promise<Map<string, unknown>> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const snapshots = await adminDb.getAll(...uniqueIds.map((id) => adminDb.collection("supplier_review_queue").doc(id)));
  return new Map(snapshots.filter((document) => document.exists).map((document) => [document.id, document.data()]));
}

/**
 * Resolves legacy-compatible queue IDs for one bounded supplier page. A second
 * read validates only the deterministic collision fallbacks selected by the
 * first pass; no collection scan is introduced.
 */
async function resolveSupplierReviewQueueIds(
  sourceId: string,
  products: readonly RawA2ZProduct[],
  queueDocuments: readonly FirebaseFirestore.QueryDocumentSnapshot[],
): Promise<Map<string, string>> {
  const identityInputs = products.map((product) => supplierReviewIdentityInput(sourceId, product));
  const legacyIds = identityInputs.map(buildLegacySupplierReviewQueueId);
  const legacyIdSet = new Set(legacyIds);
  const existingRecords = await loadSupplierReviewQueueRecords(legacyIds);
  queueDocuments.forEach((document) => existingRecords.set(document.id, document.data()));
  const reusableIds = new Map<string, string>();
  identityInputs.forEach((input) => {
    const identity = canonicalSupplierReviewIdentity(input);
    const compatibleIds = queueDocuments
      .filter((document) => supplierReviewQueueRecordMatchesIdentity(document.data(), input))
      .map((document) => document.id)
      .sort((left, right) => {
        const legacyId = buildLegacySupplierReviewQueueId(input);
        if (left === legacyId) return -1;
        if (right === legacyId) return 1;
        return left.localeCompare(right);
      });
    if (compatibleIds[0]) reusableIds.set(identity, compatibleIds[0]);
  });
  const unresolvedInputs = identityInputs.filter((input) => !reusableIds.has(canonicalSupplierReviewIdentity(input)));
  const initialPlan = planSupplierReviewQueueIds(unresolvedInputs, existingRecords);
  const fallbackIds = [...new Set([...initialPlan.values()].filter((id) => (
    !legacyIdSet.has(id) && !existingRecords.has(id)
  )))];
  const fallbackRecords = await loadSupplierReviewQueueRecords(fallbackIds);
  fallbackRecords.forEach((value, id) => existingRecords.set(id, value));
  return new Map([
    ...reusableIds,
    ...planSupplierReviewQueueIds(unresolvedInputs, existingRecords),
  ]);
}

/** Loads exact offer identities plus duplicate SKU/barcode candidates without scanning offers. */
async function loadSupplierOffersForBatch(sourceId: string, products: readonly RawA2ZProduct[]): Promise<SupplierProductOffer[]> {
  const ownOfferIds = [...new Set(products.map((product) => buildSupplierOfferId(
    sourceId,
    product.supplierProductId || product.sku,
    product.sku,
  )))];
  const skuValues = [...new Set(products.map((product) => normalizeSupplierOfferIdentity(product.sku)).filter(Boolean))];
  const barcodeValues = [...new Set(products.map((product) => normalizeSupplierOfferIdentity(product.barcode)).filter(Boolean))];
  const snapshots = await Promise.all([
    ...(ownOfferIds.length > 0 ? [adminDb.getAll(...ownOfferIds.map((id) => adminDb.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(id)))] : []),
    ...chunkValues(skuValues).map((values) => adminDb.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("skuNormalized", "in", values).get()),
    ...chunkValues(barcodeValues).map((values) => adminDb.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).where("barcodeNormalized", "in", values).get()),
  ]);
  const documents = snapshots.flatMap((snapshot) => "docs" in snapshot ? snapshot.docs : snapshot);
  const unique = new Map<string, SupplierProductOffer>();
  documents.forEach((document) => {
    if (!document.exists) return;
    const offer = projectSupplierOfferForAdmin({ id: document.id, ...document.data() });
    if (offer) unique.set(offer.id, offer);
  });
  return [...unique.values()];
}

export interface SupplierOfferTraversalSighting {
  offerId: string;
  data: {
    supplierCatalogTraversalId: string;
    supplierCatalogSeenAt: string;
  };
}

/**
 * Records only that an existing offer was returned by the connector before a
 * business filter excluded it. Commercial, content, approval, and baseline
 * fields are intentionally absent from this projection.
 */
export function buildFilteredSupplierOfferSightings(
  sourceId: string,
  retrievedProducts: readonly RawA2ZProduct[],
  selectedProducts: readonly RawA2ZProduct[],
  existingOffers: readonly Pick<SupplierProductOffer, "id">[],
  traversalId: string,
  observedAt: string,
): SupplierOfferTraversalSighting[] {
  const existingOfferIds = new Set(existingOffers.map((offer) => offer.id));
  const selectedOfferIds = new Set(selectedProducts.map((product) => buildSupplierOfferId(
    sourceId,
    product.supplierProductId || product.sku,
    product.sku,
  )));
  const sightings = new Map<string, SupplierOfferTraversalSighting>();
  retrievedProducts.forEach((product) => {
    const offerId = buildSupplierOfferId(sourceId, product.supplierProductId || product.sku, product.sku);
    if (!existingOfferIds.has(offerId) || selectedOfferIds.has(offerId)) return;
    sightings.set(offerId, {
      offerId,
      data: {
        supplierCatalogTraversalId: traversalId,
        supplierCatalogSeenAt: observedAt,
      },
    });
  });
  return [...sightings.values()];
}

export function isSupplierOfferMissingFromTraversal(
  value: Record<string, unknown>,
  traversalId: string,
): boolean {
  return value.supplierCatalogTraversalId !== traversalId
    && String(value.availability || "").toLowerCase() !== "unavailable";
}

function stageSupplierOfferObservation(input: {
  existing: SupplierProductOffer | null;
  observed: SupplierProductOffer;
  queueItemId: string;
  traversalId: string;
  observedAt: string;
  kind?: "catalog_upsert" | "catalog_removal";
}): {
  data: Record<string, unknown>;
  revision: string;
  expectation: SupplierOfferStateExpectation;
} {
  const pending = buildSupplierOfferPendingObservation({
    offer: input.observed,
    kind: input.kind || "catalog_upsert",
    reviewQueueItemId: input.queueItemId,
    observedAt: input.observedAt,
    traversalId: input.traversalId,
  });
  return {
    data: buildSupplierOfferObservationWrite({
      existing: input.existing,
      observed: input.observed,
      pending,
      traversalId: input.traversalId,
      observedAt: input.observedAt,
    }),
    revision: pending.revision,
    expectation: supplierOfferStateExpectation(input.existing || {}),
  };
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

export function resolveSupplierProductReviewVisibility(
  match: Pick<ExistingProduct, "isActive" | "active" | "visible"> | undefined,
  isNewProduct: boolean,
  reactivateSupplierProduct: boolean,
): { isActive: boolean; visible: boolean } {
  const isActive = reactivateSupplierProduct
    ? true
    : match
      ? (typeof match.isActive === "boolean" ? match.isActive : (typeof match.active === "boolean" ? match.active : true))
      : true;
  return {
    isActive,
    visible: reactivateSupplierProduct || isNewProduct ? true : match?.visible !== false,
  };
}

function buildProductPayload(
  product: RawA2ZProduct,
  match: ExistingProduct | undefined,
  categorySuggestion: SupplierCategorySuggestion,
  brandSuggestion: SupplierBrandSuggestion,
  storeBrands: readonly StoreBrandMappingCandidate[],
  comparison: { status: SupplierProductComparisonStatus; changedFields: string[]; fieldChanges?: SupplierFieldChange[] },
  settings: SupplierSettings,
  source: SupplierSource,
  targetProductId?: string,
  reactivateSupplierProduct = false,
): Record<string, unknown> {
  const docId = match?.id || targetProductId || generateSlug(product.title) || product.sku;
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
  const acceptedSupplierFieldIds = new Set(comparison.fieldChanges?.map((change) => change.field) || []);
  const acceptsField = (field: SupplierFieldChange["field"]): boolean => isNewProduct || acceptedSupplierFieldIds.has(field);
  const priceUpdateEnabled = isNewProduct || (["costPrice", "price", "comparePrice"] as const).some(acceptsField);
  const stockUpdateEnabled = acceptsField("stock");
  const titleUpdateEnabled = acceptsField("title");
  const descriptionUpdateEnabled = acceptsField("longDescription");
  const imageUpdateEnabled = acceptsField("mediaGallery");
  const imageUrl = imageUpdateEnabled ? supplierImageUrl : (match?.imageUrl || "");
  const effectiveImageUrls = imageUpdateEnabled ? imageUrls : (match?.imageUrls || (imageUrl ? [imageUrl] : []));
  const reviewVisibility = resolveSupplierProductReviewVisibility(match, isNewProduct, reactivateSupplierProduct);
  const selectedBrandId = isNewProduct
    ? (brandSuggestion.autoSelected ? brandSuggestion.mappedBrandId : "")
    : (match?.brand || "");
  const selectedBrandName = storeBrands.find((brand) => brand.id === selectedBrandId)?.name || "";
  const baseSpecs = acceptsField("specifications") ? (product.specifications || {}) : (match?.specs || {});
  const acceptedFields = isNewProduct ? true : acceptedSupplierFieldIds;
  const supplierCatalogDetails = mergeSupplierCatalogDetails(product, { ...(match || {}) }, acceptedFields);
  const supplierMetadata = mergeSupplierProductMetadata(product, match?.supplierMetadata || {}, acceptedFields);

  return {
    ...supplierCatalogDetails,
    id: docId,
    name: titleUpdateEnabled ? product.title : (match?.name || product.title),
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
    isActive: reviewVisibility.isActive,
    active: reviewVisibility.isActive,
    published: isNewProduct ? true : match?.published !== false,
    approved: isNewProduct ? true : match?.approved !== false,
    visible: reviewVisibility.visible,
    // Supplier identity remains private. Existing Zyro SKUs are preserved and
    // new catalogue SKUs are assigned server-side during approval.
    sku: match?.sku || "",
    ...(acceptsField("barcode") && product.barcode ? { barcode: product.barcode } : match?.barcode ? { barcode: match.barcode } : {}),
    supplierId: source.supplierId || source.id,
    supplierSourceId: source.id,
    supplierPriority: supplierPriority(source),
    supplierItemCode: product.sku,
    supplierMetadata,
    ...(match?.supplierFieldOwnership ? { supplierFieldOwnership: match.supplierFieldOwnership } : {}),
    supplierMedia: imageUpdateEnabled ? [] : (match?.supplierMedia || []),
    ...(acceptsField("leadTime") && product.leadTime !== undefined
      ? { supplierLeadTime: product.leadTime }
      : match?.supplierLeadTime !== undefined ? { supplierLeadTime: match.supplierLeadTime } : {}),
    ...(acceptsField("minimumOrderQuantity") && product.minimumOrderQuantity !== undefined
      ? { supplierMoq: product.minimumOrderQuantity }
      : match?.supplierMoq !== undefined ? { supplierMoq: match.supplierMoq } : {}),
    costPrice: priceUpdateEnabled ? wholesale : (match?.costPrice || 0),
    marketPrice: priceUpdateEnabled ? (product.recommendedRetailPrice || 0) : (match?.marketPrice || 0),
    rating: match?.rating ?? 0,
    reviewsCount: match?.reviewsCount ?? 0,
    createdAt: match?.createdAt || new Date().toISOString(),
  };
}

function buildPendingChange(
  queueItem: Record<string, unknown>,
  comparison: { status: SupplierProductComparisonStatus; fieldChanges?: SupplierFieldChange[] },
): Record<string, unknown> | null {
  const comparisonStatus = comparison.status;
  if (comparisonStatus === "UNCHANGED" || comparisonStatus === "NEW_PRODUCT") {
    return null;
  }
  const primaryChange = comparison.fieldChanges?.[0];

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
    oldValue: primaryChange?.before ?? "",
    newValue: primaryChange?.after ?? "",
    fieldChanges: comparison.fieldChanges || [],
    status: "Pending",
    productPayload: queueItem.productPayload,
    supplierSnapshot: queueItem.supplierSnapshot,
    canonicalProductId: queueItem.canonicalProductId,
    productId: queueItem.productId,
    supplierOfferId: queueItem.supplierOfferId,
    supplierOfferPendingRevision: queueItem.supplierOfferPendingRevision,
    matchedProductId: queueItem.matchedProductId,
    approvalBaseline: queueItem.approvalBaseline,
  };
}

interface SupplierSyncConflictWinner extends SupplierPriorityCandidate {
  queueItemId: string;
  productId?: string;
  offerId?: string;
}

export function buildSupplierReactivationComparison(
  comparison: SupplierProductComparison,
  previousAvailability: SupplierProductOffer["availability"] | undefined,
  nextAvailability: SupplierProductOffer["availability"],
): { comparison: SupplierProductComparison; reactivating: boolean } {
  const reactivating = previousAvailability === "unavailable" && nextAvailability !== "unavailable";
  if (!reactivating) return { comparison, reactivating: false };
  const availabilityChange = buildSupplierLifecycleFieldChange("availability", previousAvailability, nextAvailability);
  return {
    reactivating: true,
    comparison: {
      status: comparison.status === "UNCHANGED" ? "STOCK_CHANGED" : comparison.status,
      changedFields: [...new Set([...comparison.changedFields, availabilityChange.label])],
      fieldChanges: [
        ...comparison.fieldChanges.filter((change) => change.field !== "availability"),
        availabilityChange,
      ],
    },
  };
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
      productId: winner.productId || null,
      supplierOfferId: winner.offerId || null,
      winningPriority: winner.priority,
      resolution: "supplier_offer_attached_to_canonical_product",
      detectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

export function buildSupplierDuplicateConflictReviewItem(input: {
  queueItemId: string;
  existingQueueItem?: Record<string, unknown>;
  currentProduct?: Record<string, unknown>;
  source: SupplierSource;
  product: RawA2ZProduct;
  offer: SupplierProductOffer;
  winner: SupplierSyncConflictWinner;
  batchId: string;
  detectedAt: string;
}): { id: string; data: Record<string, unknown> } {
  const existingQueueItem = input.existingQueueItem || {};
  const currentProduct = input.currentProduct || {};
  const existingPayload = asRecord(existingQueueItem.productPayload);
  const productPayload = Object.keys(existingPayload).length > 0 ? existingPayload : currentProduct;
  const productId = String(
    existingQueueItem.canonicalProductId
    || existingQueueItem.productId
    || productPayload.id
    || input.winner.productId
    || input.offer.productId,
  ).trim();
  const queueCreatedAt = String(existingQueueItem.createdAt || existingQueueItem.queueCreatedAt || input.detectedAt);
  const validation = asRecord(existingQueueItem.productValidation);
  const validationErrors = Array.isArray(validation.errors)
    ? validation.errors.filter((error) => asRecord(error).code !== "duplicate_supplier_product")
    : [];
  const missingFields = Array.isArray(validation.missingFields)
    ? validation.missingFields.filter((field): field is string => typeof field === "string")
    : [];
  const comparison = asRecord(existingQueueItem.comparison);
  const changedFields = Array.isArray(comparison.changedFields)
    ? comparison.changedFields.filter((field): field is string => typeof field === "string")
    : [];
  const duplicateLabel = "Duplicate supplier product";
  const supplierSnapshot = {
    ...input.product,
    supplierId: input.source.supplierId || input.source.id,
    sourceId: input.source.id,
    supplierPriority: supplierPriority(input.source),
    supplierName: input.source.supplierName || input.source.name || input.source.id,
    supplierSku: input.product.sku,
  };

  return {
    id: input.queueItemId,
    data: {
      ...(Object.keys(existingQueueItem).length === 0 ? buildSupplierQueueLifecycle(queueCreatedAt) : {}),
      ...existingQueueItem,
      id: input.queueItemId,
      status: "CONFLICT",
      queueState: "conflict",
      supplierCode: input.product.sku,
      supplierName: input.source.supplierName || input.source.name || input.source.id,
      source: "Website",
      connector: String(input.source.supplierType || input.source.type || "website"),
      sourceId: input.source.id,
      supplierId: input.source.supplierId || input.source.id,
      supplierPriority: supplierPriority(input.source),
      supplierOfferId: input.offer.id,
      canonicalProductId: productId,
      productId,
      matchedProductId: input.winner.productId || productId || null,
      batchId: input.batchId,
      productName: String(productPayload.name || input.product.title),
      costPrice: input.offer.cost,
      marketPrice: input.product.recommendedRetailPrice || input.offer.price,
      stock: input.offer.stock,
      imageUrl: String(productPayload.imageUrl || input.product.mediaGallery?.[0] || ""),
      comparisonStatus: String(existingQueueItem.comparisonStatus || comparison.comparisonStatus || "UNCHANGED"),
      comparison: {
        ...comparison,
        matchFound: true,
        matchedProductId: input.winner.productId || productId || null,
        comparisonStatus: String(existingQueueItem.comparisonStatus || comparison.comparisonStatus || "UNCHANGED"),
        changedFields: [...new Set([...changedFields, duplicateLabel])],
      },
      productPayload: { ...productPayload, id: productId },
      supplierSnapshot,
      productValidation: {
        ...validation,
        readyToPublish: false,
        missingFields: [...new Set([...missingFields, duplicateLabel])],
        errors: [
          ...validationErrors,
          {
            field: "supplierCode",
            code: "duplicate_supplier_product",
            message: "This supplier product duplicates another product from the same supplier and requires manual review.",
          },
        ],
      },
      approvalConflict: {
        reason: "duplicate_supplier_product",
        changedFields: [duplicateLabel],
      },
      approvalBaseline: existingQueueItem.approvalBaseline || buildSupplierProductApprovalBaseline(
        productId,
        Object.keys(currentProduct).length > 0 ? currentProduct : undefined,
        queueCreatedAt,
      ),
      correlationId: String(existingQueueItem.correlationId || input.queueItemId),
      createdAt: queueCreatedAt,
      updatedAt: input.detectedAt,
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

async function releaseSyncLock(finishedAt: Date, batchId: string): Promise<void> {
  const reference = adminDb.collection("supplier_sync_locks").doc(LOCK_ID);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.data()?.owner !== batchId) return;
    transaction.set(reference, {
      status: "idle",
      activeSyncCount: 0,
      finishedAt: finishedAt.toISOString(),
      updatedAt: finishedAt.toISOString(),
      lockedUntil: FieldValue.delete(),
    }, { merge: true });
  });
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
  syncRequest: SupplierSyncRequest = { mode: "full" },
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
    sourceTerminationReasons: metrics.sourceTerminationReasons,
    limitedSourceIds: metrics.limitedSourceIds,
    syncRequest,
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
  /** Optimistic fence for an offer read during comparison. */
  offerStateExpectation?: SupplierOfferStateExpectation;
}

async function commitQueuedItems(items: SupplierSyncWrite[]): Promise<void> {
  let batch = adminDb.batch();
  let operationCount = 0;

  const flushBatch = async (): Promise<void> => {
    if (operationCount === 0) return;
    await batch.commit();
    batch = adminDb.batch();
    operationCount = 0;
  };

  for (let index = 0; index < items.length;) {
    const firstItem = items[index];
    let groupEnd = index + 1;
    if (firstItem.atomicGroup) {
      while (groupEnd < items.length && items[groupEnd].atomicGroup === firstItem.atomicGroup) groupEnd += 1;
    }
    const group = items.slice(index, groupEnd);
    if (group.length > 450) throw new Error("A supplier synchronization atomic write group exceeds the Firestore batch limit.");
    const fencedOffer = group.find((item) => item.offerStateExpectation);
    if (fencedOffer?.offerStateExpectation) {
      await flushBatch();
      const offerReference = adminDb.collection(fencedOffer.collection).doc(fencedOffer.id);
      const reviewWrite = group.find((item) => item.collection === "supplier_review_queue");
      const reviewReference = reviewWrite
        ? adminDb.collection(reviewWrite.collection).doc(reviewWrite.id)
        : null;
      const reviewIdentity = reviewWrite
        ? getSupplierQueueIdentityCandidate(reviewWrite.data)
        : null;
      if (reviewWrite && (!reviewIdentity?.sourceId || !reviewIdentity.supplierProductId)) {
        throw new Error("A Product Review write requires a stable supplier product identity.");
      }
      await adminDb.runTransaction(async (transaction) => {
        const [currentOffer, currentReview] = await Promise.all([
          transaction.get(offerReference),
          reviewReference ? transaction.get(reviewReference) : Promise.resolve(null),
        ]);
        if (!supplierOfferStateMatchesExpectation(
          currentOffer.data(),
          fencedOffer.offerStateExpectation!,
          currentOffer.exists,
        )) {
          throw new Error("Supplier offer state changed while its Product Review observation was being committed.");
        }
        if (currentReview?.exists && !supplierReviewQueueRecordMatchesIdentity(currentReview.data(), {
          sourceId: reviewIdentity!.sourceId,
          supplierProductId: reviewIdentity!.supplierProductId,
          supplierCode: reviewIdentity!.supplierProductId,
        })) {
          throw new Error("A deterministic Product Review ID is already owned by a different supplier product identity.");
        }
        for (const item of group) {
          const reference = adminDb.collection(item.collection).doc(item.id);
          if (item.create) transaction.create(reference, item.data);
          else transaction.set(reference, item.data, { merge: true });
        }
      });
      index = groupEnd;
      continue;
    }
    if (operationCount > 0 && operationCount + group.length > 450) {
      await flushBatch();
    }
    for (const item of group) {
      const reference = adminDb.collection(item.collection).doc(item.id);
      if (item.create) batch.create(reference, item.data);
      else batch.set(reference, item.data, { merge: true });
      operationCount++;
    }

    if (operationCount >= 450) {
      await flushBatch();
    }
    index = groupEnd;
  }

  await flushBatch();
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

export function buildSupplierOfferRemovalReviewId(
  offerId: string,
  lifecycleVersion = 0,
  previousLifecycleTerminal = false,
): string {
  const baseId = `reconcile-offer-${offerId}`.slice(0, 180);
  if (!previousLifecycleTerminal) return baseId;
  const suffix = `-v${Math.max(0, Math.floor(lifecycleVersion))}`;
  return `${baseId.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}

export function buildLegacySupplierRemovalReviewId(
  sourceId: string,
  productId: string,
  lifecycleKey = "",
  previousLifecycleTerminal = false,
): string {
  const baseId = `reconcile-${generateSlug(sourceId)}-${generateSlug(productId)}`.slice(0, 180);
  if (!previousLifecycleTerminal) return baseId;
  const normalizedLifecycle = generateSlug(lifecycleKey) || "legacy";
  const suffix = `-${normalizedLifecycle}`;
  return `${baseId.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}

async function heartbeatSyncExecutionLocks(sources: readonly SupplierSource[], batchId: string, now = Date.now()): Promise<void> {
  const globalReference = adminDb.collection("supplier_sync_locks").doc(LOCK_ID);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(globalReference);
    if (snapshot.data()?.owner !== batchId || snapshot.data()?.status !== "running") return;
    transaction.set(globalReference, {
      lockedUntil: new Date(now + LOCK_TTL_MS).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
  });
  for (const source of sources) {
    const sourceReference = adminDb.collection("supplierSources").doc(source.id);
    const lockReference = adminDb.collection("supplier_sync_locks").doc(`source-${source.id}`);
    await adminDb.runTransaction(async (transaction) => {
      const [sourceSnapshot, lockSnapshot] = await Promise.all([
        transaction.get(sourceReference),
        transaction.get(lockReference),
      ]);
      if (sourceSnapshot.data()?.syncBatchId !== batchId || lockSnapshot.data()?.owner !== batchId) return;
      const leaseExpiresAt = new Date(now + LOCK_TTL_MS).toISOString();
      transaction.set(sourceReference, {
        syncLeaseExpiresAt: leaseExpiresAt,
        syncLastHeartbeatAt: new Date(now).toISOString(),
      }, { merge: true });
      transaction.set(lockReference, {
        lockedUntil: leaseExpiresAt,
        lastHeartbeatAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }, { merge: true });
    });
  }
}

export function buildPreApprovalSupplierRemovalQueueItem(input: {
  queueItemId: string;
  queueItem: Record<string, unknown>;
  offer: SupplierProductOffer;
  source: SupplierSource;
  traversal: SupplierCatalogTraversalCheckpoint;
  batchId: string;
  detectedAt: string;
  pendingRevision?: string;
}): { id: string; data: Record<string, unknown> } | null {
  const current = input.queueItem;
  if (!input.offer.productId) return null;
  const queueCreatedAt = String(current.createdAt || current.queueCreatedAt || input.detectedAt);
  const currentPayload = asRecord(current.productPayload);
  const productPayload = buildSupplierRemovalProductPayload(input.offer.productId, currentPayload, {});
  const supplierSnapshot = {
    ...input.offer.supplierSnapshot,
    ...asRecord(current.supplierSnapshot),
    supplierId: input.offer.supplierId,
    sourceId: input.offer.sourceId,
    supplierSku: input.offer.sku,
    supplierProductId: input.offer.supplierProductId,
    reconciliationAction: "supplier_offer_unavailable",
    missingFromTraversalId: input.traversal.traversalId,
  };
  const fieldChanges = [
    buildSupplierLifecycleFieldChange("availability", input.offer.availability, "unavailable"),
    buildSupplierLifecycleFieldChange("stock", input.offer.stock, 0),
  ];
  return {
    id: input.queueItemId,
    data: {
      ...current,
      id: input.queueItemId,
      status: "Pending",
      supplierCode: input.offer.sku,
      supplierName: input.source.supplierName || input.source.name || input.source.id,
      source: "Website",
      connector: String(input.source.connectorType || input.source.supplierType || input.source.type || "website"),
      sourceId: input.offer.sourceId,
      supplierId: input.offer.supplierId,
      supplierPriority: input.offer.priority,
      supplierOfferId: input.offer.id,
      ...(input.pendingRevision ? { supplierOfferPendingRevision: input.pendingRevision } : {}),
      canonicalProductId: input.offer.productId,
      productId: input.offer.productId,
      batchId: input.batchId,
      productName: String(current.productName || currentPayload.name || input.offer.productId),
      costPrice: input.offer.cost,
      marketPrice: input.offer.price,
      stock: 0,
      imageUrl: String(currentPayload.imageUrl || current.imageUrl || ""),
      comparisonStatus: "SUPPLIER_OFFER_REMOVED",
      comparison: {
        matchFound: false,
        matchedProductId: null,
        comparisonStatus: "SUPPLIER_OFFER_REMOVED",
        changedFields: fieldChanges.map((change) => change.label),
        fieldChanges,
      },
      reconciliationAction: "supplier_offer_unavailable",
      productPayload,
      supplierSnapshot,
      matchedProductId: null,
      approvalBaseline: current.approvalBaseline || buildSupplierProductApprovalBaseline(
        input.offer.productId,
        undefined,
        queueCreatedAt,
      ),
      ...buildSupplierQueueLifecycle(queueCreatedAt),
      correlationId: String(current.correlationId || input.queueItemId),
      createdAt: queueCreatedAt,
      updatedAt: input.detectedAt,
    },
  };
}

async function queueMissingSupplierOffersForReview(
  source: SupplierSource,
  traversal: SupplierCatalogTraversalCheckpoint,
  batchId: string,
): Promise<{ queued: number; queueItemIds: string[]; materializedProductIds: Set<string> }> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let queued = 0;
  const queueItemIds: string[] = [];
  const materializedProductIds = new Set<string>();
  do {
    let query = adminDb.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION)
      .where("sourceId", "==", source.id)
      .limit(100);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    cursor = snapshot.docs.at(-1);
    const offers = snapshot.docs
      .map((document) => projectSupplierOfferForAdmin({ id: document.id, ...document.data() }))
      .filter((offer): offer is SupplierProductOffer => Boolean(offer));
    offers.forEach((offer) => { if (offer.productId) materializedProductIds.add(offer.productId); });
    const offerDocuments = new Map(snapshot.docs.map((document) => [document.id, document.data()]));
    const missing = offers.filter((offer) => isSupplierOfferMissingFromTraversal(
      offerDocuments.get(offer.id) || {},
      traversal.traversalId,
    ));
    if (missing.length > 0) {
      const productIds = [...new Set(missing.map((offer) => offer.productId).filter((value): value is string => Boolean(value)))];
      const [productSnapshots, privateSnapshots] = await Promise.all([
        productIds.length > 0 ? adminDb.getAll(...productIds.map((id) => adminDb.collection("products").doc(id))) : [],
        productIds.length > 0 ? adminDb.getAll(...productIds.map((id) => adminDb.collection(PRODUCT_PRIVATE_COLLECTION).doc(id))) : [],
      ]);
      const products = new Map<string, FirebaseFirestore.DocumentSnapshot>(
        productSnapshots.map((document): [string, FirebaseFirestore.DocumentSnapshot] => [document.id, document]),
      );
      const privateProducts = new Map<string, FirebaseFirestore.DocumentData>(
        privateSnapshots.map((document): [string, FirebaseFirestore.DocumentData] => [document.id, document.data() || {}]),
      );
      const candidateQueueIds = missing.map((offer) => (
        buildSupplierOfferRemovalReviewId(offer.id)
      ));
      const existingQueueSnapshots = candidateQueueIds.length > 0
        ? await adminDb.getAll(...candidateQueueIds.map((id) => adminDb.collection("supplier_review_queue").doc(id)))
        : [];
      const existingQueueIds = new Set(existingQueueSnapshots.filter((document) => document.exists).map((document) => document.id));
      const activeReviewSnapshots = await Promise.all(chunkValues(missing.map((offer) => offer.id)).map((offerIds) => (
        adminDb.collection("supplier_review_queue").where("supplierOfferId", "in", offerIds).get()
      )));
      const activeReviewByOfferId = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
      activeReviewSnapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => {
        const data = document.data();
        const state = String(data.queueState || "").toLowerCase();
        const status = String(data.status || "").toLowerCase();
        if (["approved", "rejected", "suppressed"].includes(state) || ["approved", "rejected"].includes(status)) return;
        const offerId = String(data.supplierOfferId || "");
        if (offerId && !activeReviewByOfferId.has(offerId)) activeReviewByOfferId.set(offerId, document);
      });
      const writes: SupplierSyncWrite[] = [];
      for (let index = 0; index < missing.length; index += 1) {
        const offer = missing[index];
        const stableQueueItemId = candidateQueueIds[index];
        const activeRemovalReview = activeReviewByOfferId.get(offer.id);
        const stableQueueSnapshot = existingQueueSnapshots[index];
        const stableState = String(stableQueueSnapshot?.data()?.queueState || stableQueueSnapshot?.data()?.status || "").toLowerCase();
        const stableIsTerminal = stableQueueSnapshot?.exists
          && ["approved", "rejected", "suppressed"].includes(stableState);
        const queueItemId = activeRemovalReview?.id || (stableIsTerminal
          ? buildSupplierOfferRemovalReviewId(offer.id, offer.stateVersion, true)
          : stableQueueItemId);
        const productSnapshot = offer.productId ? products.get(offer.productId) : undefined;
        const activePreApprovalReview = !productSnapshot?.exists ? activeReviewByOfferId.get(offer.id) : undefined;
        const atomicGroup = activePreApprovalReview?.id || queueItemId;
        const detectedAt = new Date().toISOString();
        const removalObservedOffer = buildSupplierProductOffer({
          sourceId: offer.sourceId,
          supplierId: offer.supplierId,
          supplierProductId: offer.supplierProductId,
          sku: offer.sku,
          barcode: offer.barcode,
          productId: offer.productId,
          price: offer.price,
          cost: offer.cost,
          stock: 0,
          availability: "unavailable",
          priority: offer.priority,
          health: { ...offer.health, availability: "unavailable" },
          lastSyncAt: detectedAt,
          reviewStatus: offer.reviewStatus,
          catalogPayload: offer.catalogPayload,
          supplierSnapshot: {
            ...offer.supplierSnapshot,
            reconciliationAction: "supplier_offer_unavailable",
            missingFromTraversalId: traversal.traversalId,
          },
          existing: offer,
          timestamp: detectedAt,
        });
        const stagedRemoval = stageSupplierOfferObservation({
          existing: offer,
          observed: removalObservedOffer,
          queueItemId: atomicGroup,
          traversalId: traversal.traversalId,
          observedAt: detectedAt,
          kind: "catalog_removal",
        });
        writes.push({
          collection: SUPPLIER_PRODUCT_OFFERS_COLLECTION,
          id: offer.id,
          atomicGroup,
          offerStateExpectation: stagedRemoval.expectation,
          data: {
            ...stagedRemoval.data,
            missingFromTraversalId: traversal.traversalId,
            missingDetectedAt: detectedAt,
          },
        });
        if (!offer.productId || (existingQueueIds.has(queueItemId) && !activeRemovalReview && !stableIsTerminal)) continue;
        if (!productSnapshot?.exists) {
          const activeReview = activePreApprovalReview;
          if (!activeReview) continue;
          const removal = buildPreApprovalSupplierRemovalQueueItem({
            queueItemId: activeReview.id,
            queueItem: activeReview.data(),
            offer,
            source,
            traversal,
            batchId,
            detectedAt,
            pendingRevision: stagedRemoval.revision,
          });
          if (!removal) continue;
          writes.push({ collection: "supplier_review_queue", id: removal.id, data: removal.data, atomicGroup: removal.id });
          const auditReference = adminDb.collection("supplier_approval_audit").doc();
          writes.push({
            collection: "supplier_approval_audit",
            id: auditReference.id,
            create: true,
            atomicGroup: removal.id,
            data: buildSupplierAuditEvent({
              queueItemId: removal.id,
              queueItem: removal.data,
              action: "queued",
              previousState: String(activeReview.data().queueState || activeReview.data().status || "review_pending").toLowerCase(),
              newState: "queued",
              reason: "An unapproved supplier product was absent from a verified complete catalog traversal.",
            }, auditReference.id),
          });
          queueItemIds.push(removal.id);
          queued += 1;
          continue;
        }
        const activeRemovalData = activeRemovalReview?.data() || {};
        const currentProduct = productSnapshot.data() || {};
        const privateProduct = privateProducts.get(offer.productId) || {};
        const productPayload = { ...currentProduct, ...privateProduct, id: offer.productId };
        const createdAt = String(activeRemovalData.createdAt || new Date().toISOString());
        const supplierSnapshot = {
          ...offer.supplierSnapshot,
          supplierId: offer.supplierId,
          sourceId: offer.sourceId,
          supplierSku: offer.sku,
          supplierProductId: offer.supplierProductId,
          reconciliationAction: "supplier_offer_unavailable",
          missingFromTraversalId: traversal.traversalId,
        };
        const queueData = {
          ...activeRemovalData,
          ...(Object.keys(activeRemovalData).length === 0 ? buildSupplierQueueLifecycle(createdAt) : {}),
          id: queueItemId,
          status: "Pending",
          supplierCode: offer.sku,
          supplierName: source.supplierName || source.name || source.id,
          source: "Website",
          connector: String(source.connectorType || source.supplierType || source.type || "website"),
          sourceId: offer.sourceId,
          supplierId: offer.supplierId,
          supplierPriority: offer.priority,
          supplierOfferId: offer.id,
          supplierOfferPendingRevision: stagedRemoval.revision,
          canonicalProductId: offer.productId,
          productId: offer.productId,
          batchId,
          productName: String(currentProduct.name || offer.productId),
          costPrice: offer.cost,
          marketPrice: offer.price,
          stock: 0,
          imageUrl: String(currentProduct.imageUrl || ""),
          comparisonStatus: "SUPPLIER_OFFER_REMOVED",
          comparison: {
            matchFound: true,
            matchedProductId: offer.productId,
            comparisonStatus: "SUPPLIER_OFFER_REMOVED",
            changedFields: ["Supplier availability", "Supplier stock"],
            fieldChanges: [
              buildSupplierLifecycleFieldChange("availability", offer.availability, "unavailable"),
              buildSupplierLifecycleFieldChange("stock", offer.stock, 0),
            ],
          },
          reconciliationAction: "supplier_offer_unavailable",
          productPayload,
          supplierSnapshot,
          matchedProductId: offer.productId,
          approvalBaseline: activeRemovalData.approvalBaseline
            || buildSupplierProductApprovalBaseline(offer.productId, currentProduct, createdAt),
          correlationId: String(activeRemovalData.correlationId || queueItemId),
          createdAt,
          updatedAt: detectedAt,
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
            previousState: activeRemovalReview
              ? String(activeRemovalData.queueState || activeRemovalData.status || "queued").toLowerCase()
              : null,
            newState: "queued",
            reason: "A supplier offer was absent from a verified complete catalog traversal.",
          }, auditReference.id),
        });
        queueItemIds.push(queueItemId);
        queued += 1;
      }
      await commitQueuedItems(writes);
    }
    if (snapshot.size < 100) break;
  } while (cursor);
  return { queued, queueItemIds, materializedProductIds };
}

async function queueMissingSupplierProductsForReview(
  source: SupplierSource,
  traversal: SupplierCatalogTraversalCheckpoint,
  batchId: string,
): Promise<{ queued: number; queueItemIds: string[] }> {
  const offerReconciliation = await queueMissingSupplierOffersForReview(source, traversal, batchId);
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let queued = offerReconciliation.queued;
  const queueItemIds: string[] = [...offerReconciliation.queueItemIds];
  do {
    let query = adminDb.collection(PRODUCT_PRIVATE_COLLECTION)
      .where("supplierSourceId", "==", source.id)
      .orderBy(FieldPath.documentId())
      .limit(100);
    if (cursor) query = query.startAfter(cursor);
    const privateSnapshot = await query.get();
    cursor = privateSnapshot.docs.at(-1);
    const missingDocuments = privateSnapshot.docs.filter((document) => (
      !offerReconciliation.materializedProductIds.has(document.id)
      &&
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
        buildLegacySupplierRemovalReviewId(source.id, snapshot.id)
      ));
      const existingQueueSnapshots = candidateQueueIds.length > 0
        ? await adminDb.getAll(...candidateQueueIds.map((id) => adminDb.collection("supplier_review_queue").doc(id)))
        : [];
      const activeLegacyReviewSnapshots = await Promise.all(chunkValues(candidates.map((snapshot) => snapshot.id)).map((productIds) => (
        adminDb.collection("supplier_review_queue").where("canonicalProductId", "in", productIds).limit(300).get()
      )));
      const activeRemovalByProductId = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
      activeLegacyReviewSnapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => {
        const data = document.data();
        const state = String(data.queueState || "").toLowerCase();
        const status = String(data.status || "").toLowerCase();
        if (["approved", "rejected", "suppressed"].includes(state) || ["approved", "rejected"].includes(status)) return;
        if (String(data.sourceId || "") !== source.id || data.reconciliationAction !== "deactivate_and_zero_stock") return;
        const productId = String(data.canonicalProductId || "");
        if (productId && !activeRemovalByProductId.has(productId)) activeRemovalByProductId.set(productId, document);
      });
      const writes: SupplierSyncWrite[] = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const productSnapshot = candidates[index];
        const privateProduct = missingDocuments.find((document) => document.id === productSnapshot.id)?.data() || {};
        const stableQueueItemId = candidateQueueIds[index];
        const activeRemovalReview = activeRemovalByProductId.get(productSnapshot.id);
        const stableQueueSnapshot = existingQueueSnapshots[index];
        const stableState = String(stableQueueSnapshot?.data()?.queueState || stableQueueSnapshot?.data()?.status || "").toLowerCase();
        const stableIsTerminal = stableQueueSnapshot?.exists
          && ["approved", "rejected", "suppressed"].includes(stableState);
        const queueItemId = activeRemovalReview?.id || (stableIsTerminal
          ? buildLegacySupplierRemovalReviewId(
            source.id,
            productSnapshot.id,
            String(privateProduct.supplierCatalogTraversalId || "legacy"),
            true,
          )
          : stableQueueItemId);
        const currentProduct = productSnapshot.data() || {};
        const productPayload = buildSupplierRemovalProductPayload(productSnapshot.id, currentProduct, privateProduct);
        const activeRemovalData = activeRemovalReview?.data() || {};
        const createdAt = String(activeRemovalData.createdAt || new Date().toISOString());
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
          ...activeRemovalData,
          ...(Object.keys(activeRemovalData).length === 0 ? buildSupplierQueueLifecycle(createdAt) : {}),
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
            fieldChanges: [
              buildSupplierLifecycleFieldChange("availability", currentProduct.availability || "available", "unavailable"),
              buildSupplierLifecycleFieldChange("stock", currentProduct.stock, 0),
              buildSupplierLifecycleFieldChange("visibility", currentProduct.visible !== false, false),
            ],
          },
          reconciliationAction: "deactivate_and_zero_stock",
          productPayload,
          supplierSnapshot,
          matchedProductId: productSnapshot.id,
          canonicalProductId: productSnapshot.id,
          productId: productSnapshot.id,
          approvalBaseline: activeRemovalData.approvalBaseline
            || buildSupplierProductApprovalBaseline(productSnapshot.id, currentProduct, createdAt),
          correlationId: String(activeRemovalData.correlationId || queueItemId),
          createdAt,
          updatedAt: new Date().toISOString(),
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
            previousState: activeRemovalReview
              ? String(activeRemovalData.queueState || activeRemovalData.status || "queued").toLowerCase()
              : null,
            newState: "queued",
            reason: "Product was absent from a verified complete supplier catalog traversal and requires administrator review.",
          }, auditReference.id),
        });
        queueItemIds.push(queueItemId);
        queued += 1;
      }
      await commitQueuedItems(writes);
    }
    if (privateSnapshot.size < 100) break;
  } while (cursor);
  return { queued, queueItemIds };
}

const buildRunResult = (
  batchId: string,
  status: SyncStatus,
  metrics: SyncMetrics,
  startedAtMs: number,
  syncRequest: SupplierSyncRequest,
  waitingRecommended = false,
): SupplierSyncRunResult => ({
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
  sourceTerminationReasons: { ...metrics.sourceTerminationReasons },
  limitedSourceIds: [...metrics.limitedSourceIds],
  syncRequest,
  elapsedTimeMs: Math.max(0, Date.now() - startedAtMs),
  ...(waitingRecommended ? { waitingRecommended: true } : {}),
});

export async function runSupplierSync(options: SupplierSyncRunOptions = {}): Promise<SupplierSyncRunResult> {
  const trigger = options.trigger || "scheduled";
  const syncRequest = normalizeSupplierSyncRequest(options.syncRequest);
  const requestedSourceIds = [...new Set((options.sourceIds || []).map((sourceId) => sourceId.trim()).filter(Boolean))];
  const startedAt = new Date();
  const runtimeBudgetMs = Number.isFinite(options.maxRuntimeMs) && Number(options.maxRuntimeMs) > 0
    ? Number(options.maxRuntimeMs)
    : DEFAULT_SYNC_RUNTIME_BUDGET_MS;
  const syncDeadlineMs = startedAt.getTime() + runtimeBudgetMs;
  const batchId = options.batchId || `${trigger}-${startedAt.getTime()}`;
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
    sourceTerminationReasons: {},
    limitedSourceIds: [],
  };
  let incompleteTraversalCount = 0;
  let completedSourceCount = 0;
  let cancellationInterrupted = false;
  const reportProgress = async (progress: SupplierSyncJobProgressInput): Promise<void> => {
    if (!options.control) return;
    await options.control.reportProgress({
      completedSources: completedSourceCount,
      pagesProcessed: metrics.pagesProcessed,
      productsDiscovered: metrics.productsDiscovered,
      productsObserved: metrics.productsDiscovered,
      productsScanned: metrics.productsScanned,
      productsQueued: metrics.productsQueued,
      productsFailed: metrics.productsFailed,
      ...progress,
    });
  };

  const settingsSnap = await adminDb.collection("supplier_settings").doc("config").get();
  const settings = (settingsSnap.exists ? settingsSnap.data() : {}) as SupplierSettings;

  appLogger.info("Scheduled supplier sync evaluated.", {
    batchId,
    autoSyncEnabled: !!settings.autoSyncEnabled,
    scheduler: SUPPLIER_SCHEDULER_SCHEDULE,
  });

  if (trigger === "scheduled" && !isSyncDue(settings)) {
    appLogger.info("Scheduled supplier sync skipped because automatic updates are disabled.", { batchId });
    await writeHistory(batchId, trigger, "Skipped", startedAt, new Date(), metrics, "Automatic supplier updates are disabled.", syncRequest);
    return buildRunResult(batchId, "Skipped", metrics, startedAt.getTime(), syncRequest);
  }

  let sources = selectSupplierSourcesForSync(
    await loadSupplierSources(requestedSourceIds),
    requestedSourceIds,
    settings,
    trigger,
    startedAt.getTime(),
  )
    .sort((left, right) => supplierPriority(right) - supplierPriority(left) || left.id.localeCompare(right.id));

  const totalSourceCount = sources.length;
  const sourcePartition = partitionSupplierSourcesForSyncJob(sources, batchId);
  completedSourceCount = sourcePartition.terminalSuccessful.length;
  sources = sourcePartition.pending;
  sourcePartition.terminalSuccessful.forEach((source) => {
    const checkpoint = source.catalogSync || {};
    metrics.sourceTerminationReasons[source.id] = String(checkpoint.terminationReason || checkpoint.status || "completed");
    metrics.sourceCursors[source.id] = typeof checkpoint.cursor === "string" ? checkpoint.cursor : null;
    if (checkpoint.status === "limited") metrics.limitedSourceIds.push(source.id);
    if (checkpoint.terminationReason === "catalog_complete" && typeof checkpoint.traversalId === "string") {
      metrics.lastCompletedTraversals[source.id] = checkpoint.traversalId;
    }
  });
  await reportProgress({
    phase: sources.length === 0 && completedSourceCount > 0 ? "source_completed" : "preparing",
    totalSources: totalSourceCount,
    currentSourceId: null,
    determination: "indeterminate",
    basis: "unknown",
    totalProducts: null,
    totalProductsReliability: "unknown",
  });

  if (totalSourceCount === 0) {
    appLogger.info("Supplier sync found no enabled sources due for synchronization.", { batchId, trigger, requestedSourceIds });
    await writeHistory(batchId, trigger, "Skipped", startedAt, new Date(), metrics, "No enabled supplier sources were due for synchronization.", syncRequest);
    return buildRunResult(batchId, "Skipped", metrics, startedAt.getTime(), syncRequest);
  }

  if (sources.length === 0) {
    const finishedAt = new Date();
    await writeHistory(
      batchId,
      trigger,
      "Success",
      startedAt,
      finishedAt,
      metrics,
      "All supplier sources had already completed successfully for this synchronization job.",
      syncRequest,
    );
    return buildRunResult(batchId, "Success", metrics, startedAt.getTime(), syncRequest);
  }

  const hasWritableSources = sources.some((source) => source.settings?.dryRunMode !== true);
  let syncLockAcquired = false;
  if (hasWritableSources) syncLockAcquired = await acquireSyncLock(startedAt, batchId, trigger);
  if (hasWritableSources && !syncLockAcquired) {
    const finishedAt = new Date();
    await writeHistory(batchId, trigger, "Skipped", startedAt, finishedAt, metrics, "Supplier sync skipped because another supplier sync is already running.", syncRequest);
    appLogger.warn("Scheduled supplier sync skipped because lock is already held.", { batchId });
    return buildRunResult(batchId, "Skipped", metrics, startedAt.getTime(), syncRequest, true);
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
        await writeHistory(batchId, trigger, "Skipped", startedAt, finishedAt, metrics, "All requested supplier sources are protected by active source leases.", syncRequest);
        await adminDb.collection("supplier_settings").doc("config").set({
          schedulerStatus: "idle",
          schedulerActiveSyncCount: 0,
        }, { merge: true });
        return buildRunResult(batchId, "Skipped", metrics, startedAt.getTime(), syncRequest, true);
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

    const existingQueueWinnerBySku = new Map<string, SupplierSyncConflictWinner>();

    const maxProducts = getMaxProducts(settings);
    const imageLimit = getSupplierImageLimit(settings.defaultImageLimit);
    const connectors = await SupplierRegistry.createConnectorsForSources(
      sources.map((source) => ({
        id: source.id,
        data: projectSupplierSourceForConnector(source, trigger) as FirebaseFirestore.DocumentData,
      })),
      [],
    );
    const connectorBySourceId = new Map(connectors.map((connector) => [connector.id, connector]));
    const queuedWrites: SupplierSyncWrite[] = [];
    const seenSupplierProducts = new Map<string, SupplierSyncConflictWinner>();
    const winnerBySku = new Map<string, SupplierSyncConflictWinner>(existingQueueWinnerBySku);
    const winnerByBarcode = new Map<string, SupplierSyncConflictWinner>();
    let dryRunComparisonCount = 0;
    let nonDrySourceCount = 0;

    for (const source of sources) {
      if (options.control?.shouldCancel()) {
        cancellationInterrupted = true;
        incompleteTraversalCount += 1;
        break;
      }
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
      await reportProgress({
        phase: "catalog_traversal",
        totalSources: totalSourceCount,
        currentSourceId: source.id,
        ...(totalSourceCount > 1 ? {
          determination: "indeterminate" as const,
          basis: "unknown" as const,
          totalProducts: null,
          totalProductsReliability: "unknown" as const,
        } : {}),
      });

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
              nextScheduledSyncAt: getNextSupplierSourceSyncIso(supplierSourceAutoSyncSchedule(source), Date.now()),
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
            authentication: source.authentication as SupplierSourceConfig["authentication"] | undefined,
          });
        assertSupplierSyncRequestSupported(connector, syncRequest);
        const legacySourcePageSize = resolveSupplierProductLimit(sourceSettings.productLimit, settings.productLimit, maxProducts);
        const sourcePageSize = syncRequest.pageSize || legacySourcePageSize;
        const requestFingerprint = supplierSyncRequestFingerprint(syncRequest, source, sourcePageSize);
        const resumesTraversal = ["in_progress", "paused", "reconciling"].includes(String(source.catalogSync?.status || ""))
          && source.catalogSync?.requestFingerprint === requestFingerprint
          && source.catalogSync?.syncJobId === batchId;
        const initialTraversalPages = resumesTraversal ? Number(source.catalogSync?.pagesProcessed || 0) : 0;
        const initialResumeCount = resumesTraversal ? Number(source.catalogSync?.resumeCount || 0) : 0;
        const hasPersistentFilters = Boolean(source.settings?.categoriesFilter?.length || source.settings?.brandFilter);
        const deletionReconciliationEligible = syncRequest.mode === "full"
          && !supplierSyncRequestHasFilters(syncRequest)
          && !hasPersistentFilters;
        const incrementalRequest = syncRequest.mode === "incremental"
          ? resolveSupplierIncrementalCatalogRequest(connector.syncCapabilities!, source)
          : undefined;
        const traversalResult = await runSupplierCatalogTraversal({
          connector,
          pageSize: normalizeSupplierCatalogPageSize(sourcePageSize),
          syncMode: syncRequest.mode,
          filters: nativeSupplierCatalogFilters(connector, syncRequest),
          incremental: incrementalRequest,
          totalProductLimit: normalizeSupplierTotalProductLimit(syncRequest.totalProductLimit),
          deletionReconciliationEligible,
          requestFingerprint,
          syncJobId: batchId,
          initial: source.catalogSync,
          shouldPause: () => Date.now() >= syncDeadlineMs || options.control?.shouldCancel() === true,
          persistCheckpoint: async (checkpoint) => {
            if (!dryRunMode) await adminDb.collection("supplierSources").doc(source.id).set({
              catalogCursor: checkpoint.cursor,
              catalogSync: checkpoint,
              catalogSyncMetrics: {
                pagesProcessed: checkpoint.pagesProcessed,
                productsScanned: checkpoint.productsScanned,
                productsObserved: checkpoint.productsObserved,
                productsImported: checkpoint.productsImported,
                invalidProducts: checkpoint.invalidProducts,
                deletionReconciliationEligible: checkpoint.deletionReconciliationEligible,
                cursor: checkpoint.cursor,
                syncMode: checkpoint.syncMode,
                totalProductLimit: checkpoint.totalProductLimit,
                catalogTotalProducts: checkpoint.catalogTotalProducts,
                catalogTotalReliability: checkpoint.catalogTotalReliability,
                terminationReason: checkpoint.terminationReason,
                elapsedTimeMs: Math.max(0, Date.now() - new Date(checkpoint.startedAt).getTime()),
                lastCompletedTraversal: checkpoint.syncMode === "full"
                  && checkpoint.deletionReconciliationEligible
                  && checkpoint.terminationReason === "catalog_complete"
                  ? checkpoint.traversalId
                  : null,
                resumeCount: checkpoint.resumeCount,
                updatedAt: checkpoint.lastCheckpointAt,
              },
              ...(checkpoint.syncMode === "full"
                && checkpoint.deletionReconciliationEligible
                && checkpoint.terminationReason === "catalog_complete" ? {
                lastCompletedCatalogTraversal: {
                  traversalId: checkpoint.traversalId,
                  pagesProcessed: checkpoint.pagesProcessed,
                  productsScanned: checkpoint.productsScanned,
                  productsImported: checkpoint.productsImported,
                  startedAt: checkpoint.startedAt,
                  completedAt: checkpoint.lastCheckpointAt,
                  deltaToken: checkpoint.deltaToken,
                  resumeCount: checkpoint.resumeCount,
                },
              } : {}),
            }, { merge: true });
            if (hasWritableSources) {
              await heartbeatSyncExecutionLocks(sources.filter((candidate) => candidate.settings?.dryRunMode !== true), batchId);
            }
            const hasSingleSourceTotal = totalSourceCount === 1 && checkpoint.catalogTotalProducts !== null;
            const isLimitUpperBound = totalSourceCount === 1
              && checkpoint.totalProductLimit !== null
              && !hasSingleSourceTotal;
            await reportProgress({
              phase: checkpoint.status === "reconciling" ? "reconciling" : "catalog_traversal",
              totalSources: totalSourceCount,
              currentSourceId: source.id,
              pagesProcessed: metrics.pagesProcessed + Math.max(0, checkpoint.pagesProcessed - initialTraversalPages),
              determination: hasSingleSourceTotal
                && checkpoint.catalogTotalReliability === "exact"
                && checkpoint.totalProductLimit === null
                ? "determinate"
                : "indeterminate",
              basis: hasSingleSourceTotal
                ? "catalog_total"
                : isLimitUpperBound ? "limit_upper_bound" : "unknown",
              totalProducts: hasSingleSourceTotal
                ? checkpoint.catalogTotalProducts
                : isLimitUpperBound ? checkpoint.totalProductLimit : null,
              totalProductsReliability: hasSingleSourceTotal
                ? checkpoint.catalogTotalReliability
                : isLimitUpperBound ? "reported" : "unknown",
            });
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
        const retrievedProducts = products;
        collectDiscoveredSupplierCategories(products).forEach((category) => discoveredCategoryLabels.add(category));
        const existingOffers = await loadSupplierOffersForBatch(source.id, products);
        const allExistingProducts = await loadExistingProductsForSupplierBatch(products, existingOffers);
        for (const catalogProduct of products) {
          const existing = findMatchingProduct(
            catalogProduct,
            allExistingProducts,
            source.id,
            source.supplierId || source.id,
          );
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

        products = applyServerSideSupplierCatalogFilters(
          products,
          connector,
          syncRequest,
          storeCategories,
          settings.categoryMappings,
        );

        const productsToProcess = products;
        const existingProducts = allExistingProducts;
        const filteredOfferSightings = buildFilteredSupplierOfferSightings(
          source.id,
          retrievedProducts,
          productsToProcess,
          existingOffers,
          traversalCheckpoint.traversalId,
          new Date().toISOString(),
        );
        filteredOfferSightings.forEach((sighting) => queuedWrites.push({
          collection: SUPPLIER_PRODUCT_OFFERS_COLLECTION,
          id: sighting.offerId,
          data: sighting.data,
        }));
        const queueCandidates = await loadSupplierQueueCandidates(source.id, productsToProcess);
        const queueIdsByIdentity = await resolveSupplierReviewQueueIds(
          source.id,
          productsToProcess,
          queueCandidates.review,
        );
        const activeReviewQueueDocs = queueCandidates.review.filter((queueDoc) => {
          const state = String(queueDoc.data().queueState || "").toLowerCase();
          const status = String(queueDoc.data().status || "").toLowerCase();
          return !["approved", "rejected"].includes(state) && !["approved", "rejected"].includes(status);
        });
        activeReviewQueueDocs.forEach((queueDoc) => {
          const data = queueDoc.data();
          const sku = normalizeConflictValue(data.supplierCode);
          const candidate: SupplierSyncConflictWinner = {
            supplierId: String(data.supplierId || data.sourceId || "unknown"),
            sourceId: String(data.sourceId || "unknown"),
            priority: Number.isFinite(Number(data.supplierPriority)) ? Number(data.supplierPriority) : 10_000,
            queueItemId: queueDoc.id,
            productId: String(data.canonicalProductId || data.productId || data.matchedProductId || (data.productPayload as Record<string, unknown> | undefined)?.id || "") || undefined,
            offerId: String(data.supplierOfferId || "") || undefined,
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
          requestedPageSize: normalizeSupplierCatalogPageSize(sourcePageSize),
          totalProductLimit: syncRequest.totalProductLimit || null,
          syncMode: syncRequest.mode,
          filteredCount: products.length,
          processedCount: productsToProcess.length,
        });

        for (const product of productsToProcess) {
          const reviewIdentityInput = supplierReviewIdentityInput(source.id, product);
          const reviewIdentity = canonicalSupplierReviewIdentity(reviewIdentityInput);
          let queueItemId = queueIdsByIdentity.get(reviewIdentity)
            || generateQueueDocId(source.id, product.sku, product.title);
          const normalizedSupplierCode = product.sku.trim().toLowerCase();
          const supplierProductKey = `${source.id}:${normalizedSupplierCode}`;
          const priorSupplierProduct = seenSupplierProducts.get(supplierProductKey);
          const skuWinner = winnerBySku.get(normalizedSupplierCode);
          const normalizedBarcode = normalizeConflictValue(product.barcode);
          const barcodeWinner = normalizedBarcode ? winnerByBarcode.get(normalizedBarcode) : undefined;
          const ownOfferId = buildSupplierOfferId(source.id, product.supplierProductId || product.sku, product.sku);
          const ownOffer = existingOffers.find((offer) => offer.id === ownOfferId);
          const activeReviewQueueDoc = activeReviewQueueDocs.find((queueDoc) => {
            const data = queueDoc.data();
            return String(data.supplierOfferId || "") === ownOfferId
              || (supplierReviewQueueRecordMatchesIdentity(data, reviewIdentityInput) && (
                queueDoc.id === queueItemId
                || (
                String(data.sourceId || "") === source.id
                && normalizeConflictValue(data.supplierCode) === normalizedSupplierCode
                )
              ));
          });
          if (activeReviewQueueDoc) queueItemId = activeReviewQueueDoc.id;
          const activeReviewQueueData = activeReviewQueueDoc?.data();
          const currentWinner: SupplierSyncConflictWinner = {
            supplierId: source.supplierId || source.id,
            sourceId: source.id,
            priority: supplierPriority(source),
            queueItemId,
          };
          const duplicateOffer = existingOffers
            .filter((offer) => offer.sourceId !== source.id && offer.productId && (
              offer.skuNormalized === normalizedSupplierCode
              || Boolean(normalizedBarcode && offer.barcodeNormalized === normalizedBarcode)
            ))
            .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
          const directMatch = findMatchingProduct(
            product,
            existingProducts,
            source.id,
            source.supplierId || source.id,
          );
          const zyroSkuSignal = !ownOffer?.productId && !directMatch
            ? existingProducts.find((candidate) => normalizeConflictValue(candidate.sku) === normalizedSupplierCode)
            : undefined;
          const zyroBarcodeSignal = !ownOffer?.productId && !directMatch && normalizedBarcode
            ? existingProducts.find((candidate) => normalizeConflictValue(candidate.barcode) === normalizedBarcode)
            : undefined;
          const targetProductId = ownOffer?.productId
            || directMatch?.id
            || duplicateOffer?.productId
            || skuWinner?.productId
            || barcodeWinner?.productId
            || zyroSkuSignal?.id
            || zyroBarcodeSignal?.id
            || generateSlug(product.title)
            || product.sku;
          const match = directMatch || existingProducts.find((candidate) => candidate.id === targetProductId);
          currentWinner.productId = targetProductId;
          currentWinner.offerId = ownOfferId;
          const competingSkuWinner = skuWinner && (skuWinner.sourceId !== source.id || skuWinner.queueItemId !== queueItemId)
            ? skuWinner
            : undefined;
          const competingBarcodeWinner = barcodeWinner && (barcodeWinner.sourceId !== source.id || barcodeWinner.queueItemId !== queueItemId)
            ? barcodeWinner
            : undefined;
          const duplicateOfferWinner: SupplierSyncConflictWinner | undefined = duplicateOffer?.productId ? {
            supplierId: duplicateOffer.supplierId,
            sourceId: duplicateOffer.sourceId,
            priority: duplicateOffer.priority,
            queueItemId: "",
            productId: duplicateOffer.productId,
            offerId: duplicateOffer.id,
          } : undefined;
          const zyroSkuWinner: SupplierSyncConflictWinner | undefined = zyroSkuSignal ? {
            supplierId: String(zyroSkuSignal.supplierId || "zyro-catalog"),
            sourceId: String(zyroSkuSignal.supplierSourceId || "zyro-catalog"),
            priority: 10_000,
            queueItemId: "",
            productId: zyroSkuSignal.id,
          } : undefined;
          const zyroBarcodeWinner: SupplierSyncConflictWinner | undefined = zyroBarcodeSignal ? {
            supplierId: String(zyroBarcodeSignal.supplierId || "zyro-catalog"),
            sourceId: String(zyroBarcodeSignal.supplierSourceId || "zyro-catalog"),
            priority: 10_000,
            queueItemId: "",
            productId: zyroBarcodeSignal.id,
          } : undefined;
          const duplicateOfferReason = duplicateOfferWinner
            && normalizedBarcode
            && duplicateOffer?.barcodeNormalized === normalizedBarcode
            ? "duplicate_barcode" as const
            : "duplicate_sku" as const;
          const conflict = priorSupplierProduct
            ? { reason: "duplicate_supplier_product" as const, winner: priorSupplierProduct }
            : competingSkuWinner
              ? { reason: "duplicate_sku" as const, winner: competingSkuWinner }
              : competingBarcodeWinner
                ? { reason: "duplicate_barcode" as const, winner: competingBarcodeWinner }
                : duplicateOfferWinner
                  ? { reason: duplicateOfferReason, winner: duplicateOfferWinner }
                  : zyroSkuWinner
                    ? { reason: "duplicate_sku" as const, winner: zyroSkuWinner }
                    : zyroBarcodeWinner
                      ? { reason: "duplicate_barcode" as const, winner: zyroBarcodeWinner }
                      : null;
          const createdAt = new Date().toISOString();
          const initialOffer = buildSupplierProductOffer({
            sourceId: source.id,
            supplierId: source.supplierId || source.id,
            supplierProductId: product.supplierProductId || product.sku,
            sku: product.sku,
            barcode: product.barcode,
            productId: targetProductId,
            price: calculateSupplierInitialPricing(
              product.wholesalePrice || 0,
              product.recommendedRetailPrice,
              settings.defaultMarkup,
              settings.defaultProfitMargin,
            ).sellingPrice,
            cost: product.wholesalePrice,
            stock: product.inventoryLevel,
            availability: product.availability,
            priority: supplierPriority(source),
            health: { ...(source.syncHealth || {}), availability: "available", observedAt: createdAt },
            lastSyncAt: createdAt,
            reviewStatus: ownOffer?.reviewStatus,
            catalogPayload: ownOffer?.catalogPayload || {},
            supplierSnapshot: product,
            existing: ownOffer,
            timestamp: createdAt,
          });
          const duplicateFromSameSource = Boolean(priorSupplierProduct);
          if (conflict) {
            const winner = conflict?.winner || skuWinner || currentWinner;
            const reason = conflict?.reason || "duplicate_supplier_product" as const;
            const record = buildSupplierConflictRecord(source, product, winner, reason, batchId);
            queuedWrites.push({ collection: "supplier_product_conflicts", id: record.id, data: record.data });
          }
          if (duplicateFromSameSource) {
            const stagedDuplicate = stageSupplierOfferObservation({
              existing: ownOffer || null,
              observed: initialOffer,
              queueItemId,
              traversalId: traversalCheckpoint.traversalId,
              observedAt: createdAt,
            });
            queuedWrites.push({
              collection: SUPPLIER_PRODUCT_OFFERS_COLLECTION,
              id: initialOffer.id,
              atomicGroup: queueItemId,
              offerStateExpectation: stagedDuplicate.expectation,
              data: {
                ...stagedDuplicate.data,
              },
            });
            if (!dryRunMode) {
              const queuedReviewWrite = queuedWrites.slice(pageWriteOffset).reverse().find((write) => (
                write.collection === "supplier_review_queue" && write.id === queueItemId
              ));
              const conflictReview = buildSupplierDuplicateConflictReviewItem({
                queueItemId,
                existingQueueItem: queuedReviewWrite?.data || activeReviewQueueData,
                currentProduct: match ? { ...match } : undefined,
                source,
                product,
                offer: initialOffer,
                winner: conflict?.winner || currentWinner,
                batchId,
                detectedAt: createdAt,
              });
              conflictReview.data.supplierOfferPendingRevision = stagedDuplicate.revision;
              if (queuedReviewWrite) queuedReviewWrite.data = conflictReview.data;
              else queuedWrites.push({
                collection: "supplier_review_queue",
                id: conflictReview.id,
                data: conflictReview.data,
                atomicGroup: conflictReview.id,
              });
              if (!queuedReviewWrite && !activeReviewQueueDoc) metrics.productsQueued++;
            }
            metrics.productsSkipped += 1;
            sourceRejected += 1;
            continue;
          }
          seenSupplierProducts.set(supplierProductKey, currentWinner);
          winnerBySku.set(normalizedSupplierCode, currentWinner);
          if (normalizedBarcode) winnerByBarcode.set(normalizedBarcode, currentWinner);
          const comparisonBaseline = ownOffer ? {
            ...ownOffer.catalogPayload,
            ...ownOffer.supplierSnapshot,
            supplierItemCode: ownOffer.sku,
            sku: ownOffer.sku,
            barcode: ownOffer.barcode,
            costPrice: ownOffer.cost,
            stock: ownOffer.stock,
          } : match ? { ...match } : undefined;
          const hasActiveReviewQueueItem = Boolean(activeReviewQueueDoc);
          const detectedComparison = buildSupplierProductComparison(product, comparisonBaseline);
          const reactivation = buildSupplierReactivationComparison(
            detectedComparison,
            ownOffer?.availability,
            initialOffer.availability,
          );
          const reactivatingSupplierOffer = reactivation.reactivating;
          const selectedComparison = selectSupplierComparisonForReview(
            reactivation.comparison,
            sourceSettings,
            ownOffer?.reviewStatus,
            hasActiveReviewQueueItem,
          );
          if (!selectedComparison) {
            if (ownOffer) queuedWrites.push({
              collection: SUPPLIER_PRODUCT_OFFERS_COLLECTION,
              id: ownOffer.id,
              data: {
                supplierCatalogTraversalId: traversalCheckpoint.traversalId,
                supplierCatalogSeenAt: createdAt,
                lastSyncAt: createdAt,
              },
            });
            metrics.productsSkipped += 1;
            continue;
          }
          const canonicalSelectedComparison: SupplierProductComparison = {
            ...selectedComparison,
            fieldChanges: selectedComparison.fieldChanges || [],
          };
          const comparison = activeReviewQueueData
            ? accumulateSupplierProductComparison(
              activeReviewQueueData.comparison || {
                comparisonStatus: activeReviewQueueData.comparisonStatus,
                changedFields: [],
                fieldChanges: [],
              },
              canonicalSelectedComparison,
            )
            : canonicalSelectedComparison;
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
          const productPayloadBase = match && activeReviewQueueData
            ? { ...match, ...asRecord(activeReviewQueueData.productPayload), id: match.id } as ExistingProduct
            : match;
          const productPayload = buildProductPayload(
            product,
            productPayloadBase,
            categoryMapping,
            brandMapping,
            storeBrands,
            comparison,
            settings,
            source,
            targetProductId,
            reactivatingSupplierOffer,
          );
          const productValidationErrors = validateSupplierProductForApproval(productPayload, storeCategories, storeBrands);
          const productImportWarnings = buildSupplierImportWarnings(product, productPayload);
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
          const supplierOffer = buildSupplierProductOffer({
            sourceId: source.id,
            supplierId: source.supplierId || source.id,
            supplierProductId: product.supplierProductId || product.sku,
            sku: product.sku,
            barcode: product.barcode,
            productId: targetProductId,
            price: productPayload.price,
            cost: product.wholesalePrice,
            stock: product.inventoryLevel,
            availability: product.availability,
            priority: supplierPriority(source),
            health: { ...(source.syncHealth || {}), availability: "available", observedAt: createdAt },
            lastSyncAt: createdAt,
            reviewStatus: "review_pending",
            catalogPayload: productPayload,
            supplierSnapshot,
            existing: ownOffer,
            timestamp: createdAt,
          });
          const stagedOffer = stageSupplierOfferObservation({
            existing: ownOffer || null,
            observed: supplierOffer,
            queueItemId,
            traversalId: traversalCheckpoint.traversalId,
            observedAt: createdAt,
          });
          queuedWrites.push({
            collection: SUPPLIER_PRODUCT_OFFERS_COLLECTION,
            id: supplierOffer.id,
            atomicGroup: queueItemId,
            offerStateExpectation: stagedOffer.expectation,
            data: {
              ...stagedOffer.data,
            },
          });
          const queueCreatedAt = String(activeReviewQueueData?.createdAt || activeReviewQueueData?.queueCreatedAt || createdAt);
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
            supplierOfferId: supplierOffer.id,
            supplierOfferPendingRevision: stagedOffer.revision,
            canonicalProductId: targetProductId,
            productId: targetProductId,
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
              matchedProductId: match?.id || ownOffer?.productId || duplicateOffer?.productId || skuWinner?.productId || barcodeWinner?.productId || null,
              comparisonStatus: comparison.status,
              changedFields: comparison.changedFields,
              fieldChanges: comparison.fieldChanges || [],
            },
            ...(reactivatingSupplierOffer ? { reconciliationAction: "supplier_offer_reactivated" } : {}),
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
            matchedProductId: match?.id || ownOffer?.productId || duplicateOffer?.productId || skuWinner?.productId || barcodeWinner?.productId || null,
            approvalBaseline: activeReviewQueueData?.approvalBaseline || buildSupplierProductApprovalBaseline(
              String(productPayload.id),
              match ? { ...match } : undefined,
              queueCreatedAt,
            ),
            createdAt: queueCreatedAt,
            updatedAt: createdAt,
          };

          if (dryRunMode) {
            dryRunComparisonCount++;
          } else {
            const pendingChange = buildPendingChange(queueItem, comparison);
            const baseQueueData = {
              ...queueItem,
              ...buildSupplierQueueLifecycle(queueCreatedAt),
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
            const conflictLabel = conflict?.reason === "duplicate_barcode"
              ? "Duplicate barcode"
              : conflict?.reason === "duplicate_sku"
                ? "Supplier code matches an existing product identity"
                : "Duplicate supplier product";
            const queueData = conflict ? {
              ...baseQueueData,
              status: "CONFLICT",
              queueState: "conflict",
              approvalConflict: {
                reason: conflict.reason,
                changedFields: [conflictLabel],
                matchedProductId: conflict.winner.productId || null,
                matchedSupplierOfferId: conflict.winner.offerId || null,
              },
              productValidation: {
                ...baseQueueData.productValidation,
                readyToPublish: false,
                missingFields: [...new Set([
                  ...baseQueueData.productValidation.missingFields,
                  conflictLabel,
                ])],
                errors: [
                  ...baseQueueData.productValidation.errors,
                  {
                    field: conflict.reason === "duplicate_barcode" ? "barcode" : "supplierCode",
                    code: conflict.reason,
                    message: `${conflictLabel} requires explicit administrator resolution.`,
                  },
                ],
              },
            } : baseQueueData;
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
            metrics.productsQueued++;
            if (comparison.status === "NEW_PRODUCT") metrics.productsImported++;
            else metrics.productsUpdated++;
          }
        }

            sourceQueueDepth += activeReviewQueueDocs.filter((queueDoc) => queueDoc.data().sourceId === source.id).length;
            const pageWrites = queuedWrites.splice(pageWriteOffset);
            if (!dryRunMode) {
              await commitQueuedItems(pageWrites);
            }
            if (pageInvalidProducts > 0) {
              appLogger.warn("Supplier catalog page contained invalid product records; valid writes were committed and deletion reconciliation will be withheld for this traversal.", {
                event: "supplier_catalog_page_invalid_products",
                batchId,
                sourceId: source.id,
                traversalId: traversalCheckpoint.traversalId,
                cursor: traversalCheckpoint.cursor,
                invalidProducts: pageInvalidProducts,
              });
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
            return {
              productsScanned: productsToProcess.length,
              productsImported: pageImported,
              invalidProducts: pageInvalidProducts,
            };
          },
        });

        const sourceFinishedAt = Date.now();
        metrics.pagesProcessed += Math.max(0, traversalResult.checkpoint.pagesProcessed - initialTraversalPages);
        metrics.resumeCount += Math.max(0, traversalResult.checkpoint.resumeCount - initialResumeCount);
        metrics.sourceCursors[source.id] = traversalResult.checkpoint.cursor;
        metrics.sourceTerminationReasons[source.id] = traversalResult.checkpoint.terminationReason || "unknown";
        if (traversalResult.limited) metrics.limitedSourceIds.push(source.id);
        const fullCatalogCompleted = syncRequest.mode === "full"
          && traversalResult.complete
          && traversalResult.checkpoint.deletionReconciliationEligible
          && traversalResult.checkpoint.terminationReason === "catalog_complete";
        const incrementalCatalogCompleted = syncRequest.mode === "incremental"
          && traversalResult.complete
          && !supplierSyncRequestHasFilters(syncRequest)
          && !syncRequest.totalProductLimit
          && traversalResult.checkpoint.terminationReason === "incremental_complete";
        const sourceRunSucceeded = traversalResult.complete || traversalResult.limited;
        if (fullCatalogCompleted) {
          metrics.lastCompletedTraversals[source.id] = traversalResult.checkpoint.traversalId;
        }
        if (!sourceRunSucceeded) incompleteTraversalCount += 1;
        if (!dryRunMode) {
          await adminDb.collection("supplierSources").doc(source.id).set({
            lastSync: new Date(sourceFinishedAt).toISOString(),
            ...(traversalResult.complete ? {
              lastSuccessfulSyncAt: new Date(sourceFinishedAt).toISOString(),
              syncCompletedAt: new Date(sourceFinishedAt).toISOString(),
            } : traversalResult.limited ? {
              syncCompletedAt: new Date(sourceFinishedAt).toISOString(),
              lastLimitedSyncAt: new Date(sourceFinishedAt).toISOString(),
            } : {
              lastPartialSyncAt: new Date(sourceFinishedAt).toISOString(),
            }),
            nextScheduledSyncAt: getNextSupplierSourceSyncIso(supplierSourceAutoSyncSchedule(source), sourceFinishedAt),
            currentlySyncing: false,
            syncLeaseExpiresAt: FieldValue.delete(),
            connectionStatus: sourceRunSucceeded ? "connected" : "Partial",
            lastError: sourceRunSucceeded ? "None" : "Catalog traversal paused and will resume from its persisted cursor.",
            ...(incrementalCatalogCompleted ? {
              lastCompletedIncrementalTraversal: {
                traversalId: traversalResult.checkpoint.traversalId,
                startedAt: traversalResult.checkpoint.startedAt,
                completedAt: traversalResult.checkpoint.lastCheckpointAt,
                deltaToken: traversalResult.checkpoint.deltaToken || null,
              },
            } : {}),
            syncMetrics: {
              pagesProcessed: traversalResult.checkpoint.pagesProcessed,
              productsDiscovered: sourceProductsDiscovered,
              productsScanned: traversalResult.checkpoint.productsScanned,
              productsObserved: traversalResult.checkpoint.productsObserved,
              productsImported: traversalResult.checkpoint.productsImported,
              productsRejected: sourceRejected,
              productsFailed: sourceProductsFailed,
              retries: traversalResult.checkpoint.resumeCount,
              resumeCount: traversalResult.checkpoint.resumeCount,
              cursor: traversalResult.checkpoint.cursor,
              syncMode: traversalResult.checkpoint.syncMode,
              totalProductLimit: traversalResult.checkpoint.totalProductLimit,
              catalogTotalProducts: traversalResult.checkpoint.catalogTotalProducts,
              catalogTotalReliability: traversalResult.checkpoint.catalogTotalReliability,
              terminationReason: traversalResult.checkpoint.terminationReason,
              intentionallyLimited: traversalResult.limited,
              queueDepth: sourceQueueDepth + traversalResult.checkpoint.productsImported,
              durationMs: Math.max(0, sourceFinishedAt - sourceStartedAt),
              lastCompletedTraversal: fullCatalogCompleted ? traversalResult.checkpoint.traversalId : null,
              updatedAt: new Date(sourceFinishedAt).toISOString(),
            },
            syncHealth: sourceRunSucceeded
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
          if (sourceRunSucceeded) {
            await Promise.all([
              resolveSupplierOperationalAlertSafely({
                category: "supplier_sync_failure",
                supplierId: String(source.supplierId || source.id),
              }),
              resolveSupplierOperationalAlertSafely({
                category: "supplier_connection_failure",
                supplierId: String(source.supplierId || source.id),
              }),
            ]);
          }
        }
        if (sourceRunSucceeded) completedSourceCount += 1;
        await reportProgress({
          phase: sourceRunSucceeded ? "source_completed" : "waiting",
          totalSources: totalSourceCount,
          currentSourceId: null,
        });
      } catch (error: any) {
        queuedWrites.splice(sourceWriteOffset);
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
            nextScheduledSyncAt: getNextSupplierSourceSyncIso(supplierSourceAutoSyncSchedule(source), Date.now()),
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
          await recordSupplierOperationalAlertSafely({
            category: "supplier_sync_failure",
            severity: "critical",
            supplierId: String(source.supplierId || source.id),
            batchId,
            technicalMetadata: {
              sourceId: source.id,
              supplierName,
              failureClassification,
              reason: message,
              productsDiscovered: sourceProductsDiscovered,
              productsFailed: Math.max(1, sourceProductsFailed),
            },
          });
        }
        await reportProgress({
          phase: "source_failed",
          totalSources: totalSourceCount,
          currentSourceId: null,
        });
        // A single connector failure must not prevent remaining suppliers from syncing.
        continue;
      }
    }

    if (nonDrySourceCount === 0) {
      const finishedAt = new Date();
      const dryRunStatus = resolveSupplierSyncRunStatus({
        completedSources: completedSourceCount,
        failedSources: metrics.sourceFailures,
        incompleteSources: incompleteTraversalCount,
        interrupted: cancellationInterrupted,
      });
      await writeHistory(batchId, trigger, dryRunStatus, startedAt, finishedAt, metrics, "Supplier dry run completed without queue writes.", syncRequest);
      appLogger.info("Scheduled supplier dry run completed without database queue writes.", {
        batchId,
        status: dryRunStatus,
        productsScanned: metrics.productsScanned,
        comparisons: dryRunComparisonCount,
      });
      return buildRunResult(
        batchId,
        dryRunStatus,
        metrics,
        startedAt.getTime(),
        syncRequest,
        cancellationInterrupted || incompleteTraversalCount > 0,
      );
    }

    await commitQueuedItems(queuedWrites);
    const finishedAt = new Date();
    await releaseSourceSyncLeases(sources.filter((source) => source.settings?.dryRunMode !== true), batchId, finishedAt.getTime());
    const status = resolveSupplierSyncRunStatus({
      completedSources: completedSourceCount,
      failedSources: metrics.sourceFailures,
      incompleteSources: incompleteTraversalCount,
      interrupted: cancellationInterrupted,
    });
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
        sourceTerminationReasons: metrics.sourceTerminationReasons,
        limitedSourceIds: metrics.limitedSourceIds,
        syncRequest,
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
      `${trigger} supplier sync discovered ${metrics.productsDiscovered} products, scanned ${metrics.productsScanned}, queued ${metrics.productsQueued}, and skipped ${metrics.productsSkipped}.`,
      syncRequest,
    );

    appLogger.info("Scheduled supplier sync finished.", {
      batchId,
      status,
      productsScanned: metrics.productsScanned,
      productsQueued: metrics.productsQueued,
      errorCount: metrics.errors.length,
    });
    if (trigger === "scheduled" && status === "Success") {
      await resolveSupplierOperationalAlertSafely({
        category: "scheduler_failure",
        dedupeScope: "supplier-sync-scheduler",
      });
    }
    return buildRunResult(
      batchId,
      status,
      metrics,
      startedAt.getTime(),
      syncRequest,
      cancellationInterrupted || incompleteTraversalCount > 0,
    );
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
      await writeHistory(batchId, trigger, "Failed", startedAt, finishedAt, metrics, error?.message || "Scheduled sync failed.", syncRequest);
      await clearInterruptedSourceSyncMarkers(sources, batchId, error?.message || "Supplier sync interrupted.");
      await adminDb.collection("supplier_settings").doc("config").set({
        schedulerStatus: "failed",
        schedulerActiveSyncCount: 0,
        schedulerLastStatus: "Failed",
        schedulerLastRunBatchId: batchId,
        schedulerLastRunFinishedAt: finishedAt.toISOString(),
      }, { merge: true });
    }
    await recordSupplierOperationalAlertSafely({
      category: trigger === "scheduled" ? "scheduler_failure" : "supplier_sync_failure",
      severity: "critical",
      jobId: batchId,
      batchId,
      dedupeScope: "supplier-sync-scheduler",
      technicalMetadata: {
        trigger,
        productsScanned: metrics.productsScanned,
        productsQueued: metrics.productsQueued,
        reason: error instanceof Error ? error.message : String(error || "Scheduled sync failed."),
      },
    });
    throw error;
  } finally {
    if (syncLockAcquired) await releaseSyncLock(new Date(), batchId);
  }
}

export async function runScheduledSupplierSync(now = Date.now()): Promise<void> {
  const scheduleBucket = new Date(now).toISOString().slice(0, 16).replace(/[^0-9]/g, "");
  await createSupplierSyncJob(adminDb, {
    trigger: "scheduled",
    requestedBy: { uid: "system", email: "" },
    dedupeKey: `scheduled-${scheduleBucket}`,
  }, now);
}

/** Admin-facing operational snapshot. It reads existing run/source metadata only. */
export async function getSupplierSyncSchedulerStatus(): Promise<Record<string, unknown>> {
  const [settingsSnapshot, lockSnapshot, historySnapshot, activeSourcesCount, latestJobSnapshot] = await Promise.all([
    adminDb.collection("supplier_settings").doc("config").get(),
    adminDb.collection("supplier_sync_locks").doc(LOCK_ID).get(),
    adminDb.collection("supplier_sync_history").orderBy("createdAt", "desc").limit(1).get(),
    adminDb.collection("supplierSources").where("currentlySyncing", "==", true).count().get(),
    adminDb.collection("supplier_sync_jobs").orderBy("createdAt", "desc").limit(1).get(),
  ]);
  const settings = settingsSnapshot.data() || {};
  const lock = lockSnapshot.data() || {};
  const lastRun = historySnapshot.docs[0];
  const latestJob = latestJobSnapshot.docs[0];
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
    latestJob: latestJob ? { id: latestJob.id, ...latestJob.data() } : null,
  };
}

export const scheduledSupplierSync = onSchedule({
  schedule: SUPPLIER_SCHEDULER_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "1GiB",
}, async (event) => {
  const scheduledAt = Date.parse(event.scheduleTime);
  try {
    await runScheduledSupplierSync(Number.isFinite(scheduledAt) ? scheduledAt : Date.now());
  } catch (error) {
    await recordSupplierOperationalAlertSafely({
      category: "scheduler_failure",
      severity: "critical",
      dedupeScope: "supplier-sync-scheduler",
      technicalMetadata: {
        scheduleTime: event.scheduleTime,
        reason: error instanceof Error ? error.message : String(error || "Supplier scheduler failed."),
      },
    });
    throw error;
  }
});
