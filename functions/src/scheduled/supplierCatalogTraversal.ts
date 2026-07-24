import { createHash, randomUUID } from "node:crypto";
import { SupplierCatalogPageResult, SupplierConnector } from "../api/suppliers/types";

export type SupplierCatalogTraversalStatus = "in_progress" | "paused" | "reconciling" | "completed";

export interface SupplierCatalogTraversalCheckpoint {
  traversalId: string;
  cursor: string | null;
  pagesProcessed: number;
  productsScanned: number;
  productsImported: number;
  resumeCount: number;
  startedAt: string;
  lastCheckpointAt: string;
  lastPageFingerprint: string | null;
  status: SupplierCatalogTraversalStatus;
}

export interface SupplierCatalogPageMetrics {
  productsScanned: number;
  productsImported: number;
}

export interface SupplierCatalogTraversalResult {
  complete: boolean;
  paused: boolean;
  checkpoint: SupplierCatalogTraversalCheckpoint;
}

export interface SupplierCatalogTraversalOptions {
  connector: Pick<SupplierConnector, "fetchProductPage">;
  pageSize: number;
  initial?: Partial<SupplierCatalogTraversalCheckpoint>;
  processPage(page: SupplierCatalogPageResult, checkpoint: SupplierCatalogTraversalCheckpoint): Promise<SupplierCatalogPageMetrics>;
  persistCheckpoint(checkpoint: SupplierCatalogTraversalCheckpoint): Promise<void>;
  reconcileDeletedProducts(checkpoint: SupplierCatalogTraversalCheckpoint): Promise<void>;
  shouldPause?: () => boolean;
  now?: () => number;
  traversalId?: string;
}

const safeCount = (value: unknown): number => {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
};

const pageFingerprint = (page: SupplierCatalogPageResult): string => createHash("sha256")
  .update(JSON.stringify(page.products))
  .digest("hex");

export function normalizeSupplierCatalogPageSize(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

export function createSupplierCatalogTraversalCheckpoint(
  initial: Partial<SupplierCatalogTraversalCheckpoint> = {},
  options: { now?: number; traversalId?: string } = {},
): SupplierCatalogTraversalCheckpoint {
  const now = options.now ?? Date.now();
  const resumable = ["in_progress", "paused", "reconciling"].includes(String(initial.status || ""));
  const startedAt = resumable && typeof initial.startedAt === "string" && initial.startedAt
    ? initial.startedAt
    : new Date(now).toISOString();
  return {
    traversalId: resumable && typeof initial.traversalId === "string" && initial.traversalId
      ? initial.traversalId
      : options.traversalId || randomUUID(),
    cursor: typeof initial.cursor === "string" && initial.cursor ? initial.cursor : null,
    pagesProcessed: resumable ? safeCount(initial.pagesProcessed) : 0,
    productsScanned: resumable ? safeCount(initial.productsScanned) : 0,
    productsImported: resumable ? safeCount(initial.productsImported) : 0,
    resumeCount: resumable ? safeCount(initial.resumeCount) + 1 : 0,
    startedAt,
    lastCheckpointAt: new Date(now).toISOString(),
    lastPageFingerprint: resumable && typeof initial.lastPageFingerprint === "string" ? initial.lastPageFingerprint : null,
    status: initial.status === "reconciling" ? "reconciling" : "in_progress",
  };
}

export async function runSupplierCatalogTraversal(options: SupplierCatalogTraversalOptions): Promise<SupplierCatalogTraversalResult> {
  const now = options.now || Date.now;
  let checkpoint = createSupplierCatalogTraversalCheckpoint(options.initial, {
    now: now(),
    traversalId: options.traversalId,
  });

  if (checkpoint.status === "reconciling") {
    await options.reconcileDeletedProducts(checkpoint);
    checkpoint = { ...checkpoint, status: "completed", lastCheckpointAt: new Date(now()).toISOString() };
    await options.persistCheckpoint(checkpoint);
    return { complete: true, paused: false, checkpoint };
  }

  while (true) {
    if (options.shouldPause?.()) {
      checkpoint = { ...checkpoint, status: "paused", lastCheckpointAt: new Date(now()).toISOString() };
      await options.persistCheckpoint(checkpoint);
      return { complete: false, paused: true, checkpoint };
    }

    const requestedCursor = checkpoint.cursor;
    const page = await options.connector.fetchProductPage({
      cursor: requestedCursor,
      pageSize: normalizeSupplierCatalogPageSize(options.pageSize),
    });
    const fingerprint = pageFingerprint(page);
    if (!page.complete && checkpoint.lastPageFingerprint === fingerprint) {
      throw new Error("Supplier connector returned the same catalog page twice without completing traversal.");
    }
    if (!page.complete && (!page.nextCursor || page.nextCursor === requestedCursor)) {
      throw new Error("Supplier connector did not provide a forward-only cursor for an incomplete catalog page.");
    }

    const pageMetrics = await options.processPage(page, checkpoint);
    checkpoint = {
      ...checkpoint,
      cursor: page.complete ? null : page.nextCursor,
      pagesProcessed: checkpoint.pagesProcessed + 1,
      productsScanned: checkpoint.productsScanned + safeCount(pageMetrics.productsScanned),
      productsImported: checkpoint.productsImported + safeCount(pageMetrics.productsImported),
      lastCheckpointAt: new Date(now()).toISOString(),
      lastPageFingerprint: fingerprint,
      status: page.complete ? "reconciling" : "in_progress",
    };
    await options.persistCheckpoint(checkpoint);

    if (page.complete) {
      await options.reconcileDeletedProducts(checkpoint);
      checkpoint = { ...checkpoint, status: "completed", lastCheckpointAt: new Date(now()).toISOString() };
      await options.persistCheckpoint(checkpoint);
      return { complete: true, paused: false, checkpoint };
    }
  }
}
