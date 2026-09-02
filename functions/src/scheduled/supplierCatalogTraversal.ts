import { createHash, randomUUID } from "node:crypto";
import {
  SupplierCatalogFilterRequest,
  SupplierCatalogPageResult,
  SupplierCatalogSyncMode,
  SupplierConnector,
  SupplierIncrementalCatalogRequest,
} from "../api/suppliers/types";

export type SupplierCatalogTraversalStatus = "in_progress" | "paused" | "reconciling" | "completed" | "limited";
export type SupplierCatalogTraversalTerminationReason = "catalog_complete" | "incremental_complete" | "limit_reached" | "paused" | null;

export interface SupplierCatalogTraversalCheckpoint {
  traversalId: string;
  cursor: string | null;
  pagesProcessed: number;
  productsScanned: number;
  /** Connector products observed before business filtering. */
  productsObserved: number;
  productsImported: number;
  invalidProducts: number;
  deletionReconciliationEligible: boolean;
  resumeCount: number;
  startedAt: string;
  lastCheckpointAt: string;
  lastPageFingerprint: string | null;
  /** Bounded hashes prevent cursor/page cycles without persisting supplier cursor values. */
  recentPageFingerprints?: string[];
  recentCursorFingerprints?: string[];
  syncMode: SupplierCatalogSyncMode;
  requestFingerprint: string | null;
  syncJobId: string | null;
  totalProductLimit: number | null;
  /** Connector total for this traversal scope; reported totals never imply determinate progress. */
  catalogTotalProducts: number | null;
  catalogTotalReliability: "exact" | "reported" | "unknown";
  deltaToken: string | null;
  terminationReason: SupplierCatalogTraversalTerminationReason;
  status: SupplierCatalogTraversalStatus;
  /** Cumulative observations at the start of the current limited batch. */
  productsObservedAtBatchStart?: number;
}

export interface SupplierCatalogPageMetrics {
  productsScanned: number;
  productsImported: number;
  invalidProducts?: number;
}

export interface SupplierCatalogTraversalResult {
  complete: boolean;
  paused: boolean;
  limited: boolean;
  checkpoint: SupplierCatalogTraversalCheckpoint;
}

export interface SupplierCatalogTraversalOptions {
  connector: Pick<SupplierConnector, "fetchProductPage" | "syncCapabilities">;
  pageSize: number;
  syncMode?: SupplierCatalogSyncMode;
  filters?: SupplierCatalogFilterRequest;
  incremental?: SupplierIncrementalCatalogRequest;
  totalProductLimit?: number | null;
  /** False for incremental, filtered, or otherwise partial catalogue scopes. */
  deletionReconciliationEligible?: boolean;
  requestFingerprint?: string;
  syncJobId?: string;
  initial?: Partial<SupplierCatalogTraversalCheckpoint>;
  processPage(page: SupplierCatalogPageResult, checkpoint: SupplierCatalogTraversalCheckpoint): Promise<SupplierCatalogPageMetrics>;
  persistCheckpoint(checkpoint: SupplierCatalogTraversalCheckpoint): Promise<void>;
  reconcileDeletedProducts(checkpoint: SupplierCatalogTraversalCheckpoint): Promise<void>;
  shouldPause?: () => boolean;
  now?: () => number;
  traversalId?: string;
  catalogContinuation?: "continue" | "restart";
}

const safeCount = (value: unknown): number => {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
};

const pageFingerprint = (page: SupplierCatalogPageResult): string => createHash("sha256")
  .update(JSON.stringify(page.products))
  .digest("hex");

const MAX_RECENT_TRAVERSAL_FINGERPRINTS = 64;
const MAX_PERSISTED_CURSOR_LENGTH = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class SupplierCatalogTraversalIntegrityError extends Error {
  readonly code = "supplier_catalog_traversal_integrity";

  constructor(message: string) {
    super(message);
    this.name = "SupplierCatalogTraversalIntegrityError";
  }
}

const boundedFingerprints = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && SHA256_PATTERN.test(entry)))]
    .slice(-MAX_RECENT_TRAVERSAL_FINGERPRINTS)
  : [];

const appendBoundedFingerprint = (values: readonly string[], value: string): string[] => [
  ...values.filter((entry) => entry !== value),
  value,
].slice(-MAX_RECENT_TRAVERSAL_FINGERPRINTS);

const cursorFingerprint = (cursor: string): string => createHash("sha256").update(cursor).digest("hex");

const validatePageEnvelope = (page: SupplierCatalogPageResult): void => {
  if (!page || !Array.isArray(page.products) || typeof page.complete !== "boolean") {
    throw new SupplierCatalogTraversalIntegrityError("Supplier connector returned an invalid catalogue page envelope.");
  }
  if (page.nextCursor !== null && page.nextCursor !== undefined) {
    if (
      typeof page.nextCursor !== "string"
      || !page.nextCursor
      || page.nextCursor.length > MAX_PERSISTED_CURSOR_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(page.nextCursor)
    ) {
      throw new SupplierCatalogTraversalIntegrityError("Supplier connector returned an invalid catalogue cursor.");
    }
  }
  if (page.complete && page.nextCursor) {
    throw new SupplierCatalogTraversalIntegrityError("Supplier connector returned a cursor after declaring catalogue completion.");
  }
};

const safeOptionalCount = (value: unknown): number | null => {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
};

const catalogTotalReliability = (value: unknown): "exact" | "reported" | "unknown" => (
  value === "exact" || value === "reported" ? value : "unknown"
);

const mergeCatalogTotal = (
  checkpoint: Pick<SupplierCatalogTraversalCheckpoint, "catalogTotalProducts" | "catalogTotalReliability">,
  page: SupplierCatalogPageResult,
): Pick<SupplierCatalogTraversalCheckpoint, "catalogTotalProducts" | "catalogTotalReliability"> => {
  const pageTotal = safeOptionalCount(page.catalogTotal?.count);
  const pageReliability = catalogTotalReliability(page.catalogTotal?.reliability);
  if (pageTotal === null || pageReliability === "unknown") return checkpoint;
  if (checkpoint.catalogTotalProducts === null) {
    return { catalogTotalProducts: pageTotal, catalogTotalReliability: pageReliability };
  }
  if (checkpoint.catalogTotalProducts !== pageTotal) {
    return { catalogTotalProducts: pageTotal, catalogTotalReliability: "reported" };
  }
  return {
    catalogTotalProducts: pageTotal,
    catalogTotalReliability: checkpoint.catalogTotalReliability === "exact" && pageReliability === "exact"
      ? "exact"
      : "reported",
  };
};

export function normalizeSupplierCatalogPageSize(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

export function normalizeSupplierTotalProductLimit(value: unknown, maximum = 10_000): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, Math.max(1, Math.floor(maximum)));
}

export function createSupplierCatalogTraversalCheckpoint(
  initial: Partial<SupplierCatalogTraversalCheckpoint> = {},
  options: {
    now?: number;
    traversalId?: string;
    syncMode?: SupplierCatalogSyncMode;
    requestFingerprint?: string;
    syncJobId?: string;
    totalProductLimit?: number | null;
    deletionReconciliationEligible?: boolean;
    catalogContinuation?: "continue" | "restart";
  } = {},
): SupplierCatalogTraversalCheckpoint {
  const now = options.now ?? Date.now();
  const requestedMode = options.syncMode === "incremental" ? "incremental" : "full";
  const requestedFingerprint = String(options.requestFingerprint || "").trim();
  const requestedJobId = String(options.syncJobId || "").trim();
  const restartRequested = options.catalogContinuation === "restart";
  const sameRequestScope = (!requestedFingerprint || initial.requestFingerprint === requestedFingerprint)
    && (!initial.syncMode || initial.syncMode === requestedMode);
  const sameJobScope = sameRequestScope
    && (!requestedJobId || initial.syncJobId === requestedJobId);
  const limitedContinuation = options.catalogContinuation === "continue"
    && !restartRequested
    && initial.status === "limited"
    && initial.terminationReason === "limit_reached"
    && sameRequestScope
    && Boolean(requestedFingerprint);
  const standardResume = !restartRequested
    && sameJobScope
    && ["in_progress", "paused", "reconciling"].includes(String(initial.status || ""));
  const resumable = limitedContinuation || standardResume;
  const requestedTotalProductLimit = normalizeSupplierTotalProductLimit(options.totalProductLimit);
  const startedAt = resumable && typeof initial.startedAt === "string" && initial.startedAt
    ? initial.startedAt
    : new Date(now).toISOString();
  const resumedProductsObserved = resumable ? safeCount(initial.productsObserved ?? initial.productsScanned) : 0;
  const productsObservedAtBatchStart = limitedContinuation
    ? resumedProductsObserved
    : resumable
      ? safeCount(initial.productsObservedAtBatchStart)
      : 0;
  return {
    traversalId: resumable && typeof initial.traversalId === "string" && initial.traversalId
      ? initial.traversalId
      : options.traversalId || randomUUID(),
    cursor: resumable && typeof initial.cursor === "string" && initial.cursor ? initial.cursor : null,
    pagesProcessed: resumable ? safeCount(initial.pagesProcessed) : 0,
    productsScanned: resumable ? safeCount(initial.productsScanned) : 0,
    productsObserved: resumedProductsObserved,
    productsObservedAtBatchStart,
    productsImported: resumable ? safeCount(initial.productsImported) : 0,
    invalidProducts: resumable ? safeCount(initial.invalidProducts) : 0,
    deletionReconciliationEligible: resumable
      ? initial.deletionReconciliationEligible !== false
      : options.deletionReconciliationEligible !== false && requestedMode === "full",
    resumeCount: resumable ? safeCount(initial.resumeCount) + 1 : 0,
    startedAt,
    lastCheckpointAt: new Date(now).toISOString(),
    lastPageFingerprint: resumable && typeof initial.lastPageFingerprint === "string" ? initial.lastPageFingerprint : null,
    recentPageFingerprints: resumable
      ? boundedFingerprints(initial.recentPageFingerprints || (initial.lastPageFingerprint ? [initial.lastPageFingerprint] : []))
      : [],
    recentCursorFingerprints: resumable ? boundedFingerprints(initial.recentCursorFingerprints) : [],
    syncMode: requestedMode,
    requestFingerprint: requestedFingerprint || null,
    syncJobId: requestedJobId || null,
    totalProductLimit: resumable
      ? normalizeSupplierTotalProductLimit(initial.totalProductLimit ?? requestedTotalProductLimit)
      : requestedTotalProductLimit,
    catalogTotalProducts: resumable ? safeOptionalCount(initial.catalogTotalProducts) : null,
    catalogTotalReliability: resumable
      ? catalogTotalReliability(initial.catalogTotalReliability)
      : "unknown",
    deltaToken: resumable && typeof initial.deltaToken === "string" && initial.deltaToken
      ? initial.deltaToken
      : null,
    terminationReason: null,
    status: resumable && initial.status === "reconciling" ? "reconciling" : "in_progress",
  };
}

export async function runSupplierCatalogTraversal(options: SupplierCatalogTraversalOptions): Promise<SupplierCatalogTraversalResult> {
  const now = options.now || Date.now;
  const hasFilters = Object.values(options.filters || {}).some((value) => String(value || "").trim().length > 0);
  let checkpoint = createSupplierCatalogTraversalCheckpoint(options.initial, {
    now: now(),
    traversalId: options.traversalId,
    syncMode: options.syncMode,
    requestFingerprint: options.requestFingerprint,
    syncJobId: options.syncJobId,
    totalProductLimit: options.totalProductLimit,
    deletionReconciliationEligible: hasFilters ? false : options.deletionReconciliationEligible,
    catalogContinuation: options.catalogContinuation,
  });
  if (hasFilters && checkpoint.deletionReconciliationEligible) {
    checkpoint = { ...checkpoint, deletionReconciliationEligible: false };
  }

  if (checkpoint.syncMode === "incremental" && options.connector.syncCapabilities?.incremental.supported !== true) {
    throw new Error("This supplier connector does not support true incremental synchronization.");
  }

  if (checkpoint.status === "reconciling") {
    if (checkpoint.deletionReconciliationEligible) {
      await options.reconcileDeletedProducts(checkpoint);
    }
    checkpoint = {
      ...checkpoint,
      status: "completed",
      terminationReason: "catalog_complete",
      lastCheckpointAt: new Date(now()).toISOString(),
    };
    await options.persistCheckpoint(checkpoint);
    return { complete: true, paused: false, limited: false, checkpoint };
  }

  while (true) {
    if (options.shouldPause?.()) {
      checkpoint = {
        ...checkpoint,
        status: "paused",
        terminationReason: "paused",
        lastCheckpointAt: new Date(now()).toISOString(),
      };
      await options.persistCheckpoint(checkpoint);
      return { complete: false, paused: true, limited: false, checkpoint };
    }

    const requestedCursor = checkpoint.cursor;
    const batchBaseline = safeCount(checkpoint.productsObservedAtBatchStart);
    const remainingLimit = checkpoint.totalProductLimit === null
      ? null
      : Math.max(0, checkpoint.totalProductLimit - (checkpoint.productsObserved - batchBaseline));
    if (remainingLimit === 0) {
      checkpoint = {
        ...checkpoint,
        deletionReconciliationEligible: false,
        status: "limited",
        terminationReason: "limit_reached",
        lastCheckpointAt: new Date(now()).toISOString(),
      };
      await options.persistCheckpoint(checkpoint);
      return { complete: false, paused: false, limited: true, checkpoint };
    }
    const requestedPageSize = Math.min(
      normalizeSupplierCatalogPageSize(options.pageSize),
      remainingLimit ?? Number.MAX_SAFE_INTEGER,
    );
    const page = await options.connector.fetchProductPage({
      cursor: requestedCursor,
      pageSize: requestedPageSize,
      mode: checkpoint.syncMode,
      filters: options.filters,
      incremental: checkpoint.syncMode === "incremental" ? options.incremental : undefined,
    });
    validatePageEnvelope(page);
    const pageObservedProducts = page.products.length + safeCount(page.invalidProducts);
    if (pageObservedProducts > requestedPageSize) {
      throw new Error("Supplier connector returned more products than the bounded page request allowed.");
    }
    const fingerprint = pageFingerprint(page);
    const recentPageFingerprints = boundedFingerprints(checkpoint.recentPageFingerprints);
    const recentCursorFingerprints = boundedFingerprints(checkpoint.recentCursorFingerprints);
    if (recentPageFingerprints.includes(fingerprint)) {
      throw new SupplierCatalogTraversalIntegrityError("Supplier connector repeated a previously processed catalogue page.");
    }
    if (!page.complete && (!page.nextCursor || page.nextCursor === requestedCursor)) {
      throw new SupplierCatalogTraversalIntegrityError("Supplier connector did not provide a forward-only cursor for an incomplete catalogue page.");
    }
    if (!page.complete && page.nextCursor && recentCursorFingerprints.includes(cursorFingerprint(page.nextCursor))) {
      throw new SupplierCatalogTraversalIntegrityError("Supplier connector returned a cyclic catalogue cursor.");
    }

    const pageMetrics = await options.processPage(page, checkpoint);
    const pageInvalidProducts = safeCount(pageMetrics.invalidProducts);
    const productsObserved = checkpoint.productsObserved + pageObservedProducts;
    const limitReached = checkpoint.totalProductLimit !== null
      && (productsObserved - batchBaseline) >= checkpoint.totalProductLimit;
    const deletionReconciliationEligible = checkpoint.deletionReconciliationEligible
      && pageInvalidProducts === 0
      && !limitReached;
    const catalogTotal = mergeCatalogTotal(checkpoint, page);
    checkpoint = {
      ...checkpoint,
      ...catalogTotal,
      cursor: page.complete ? null : page.nextCursor,
      pagesProcessed: checkpoint.pagesProcessed + 1,
      productsScanned: checkpoint.productsScanned + safeCount(pageMetrics.productsScanned),
      productsObserved,
      productsImported: checkpoint.productsImported + safeCount(pageMetrics.productsImported),
      invalidProducts: checkpoint.invalidProducts + pageInvalidProducts,
      deltaToken: typeof page.deltaToken === "string" && page.deltaToken ? page.deltaToken : checkpoint.deltaToken,
      deletionReconciliationEligible,
      lastCheckpointAt: new Date(now()).toISOString(),
      lastPageFingerprint: fingerprint,
      recentPageFingerprints: appendBoundedFingerprint(recentPageFingerprints, fingerprint),
      recentCursorFingerprints: requestedCursor
        ? appendBoundedFingerprint(recentCursorFingerprints, cursorFingerprint(requestedCursor))
        : recentCursorFingerprints,
      terminationReason: limitReached
        ? "limit_reached"
        : page.complete
          ? checkpoint.syncMode === "incremental" ? "incremental_complete" : "catalog_complete"
          : null,
      status: limitReached
        ? "limited"
        : page.complete && deletionReconciliationEligible
          ? "reconciling"
          : page.complete
            ? "completed"
            : "in_progress",
    };
    await options.persistCheckpoint(checkpoint);

    if (limitReached) return { complete: false, paused: false, limited: true, checkpoint };

    if (page.complete) {
      if (checkpoint.deletionReconciliationEligible) {
        await options.reconcileDeletedProducts(checkpoint);
        checkpoint = { ...checkpoint, status: "completed", lastCheckpointAt: new Date(now()).toISOString() };
        await options.persistCheckpoint(checkpoint);
      }
      return { complete: true, paused: false, limited: false, checkpoint };
    }
  }
}
