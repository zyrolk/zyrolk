import { FieldPath, FieldValue, Firestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";
import { DROPEX_SECRETS } from "../config/secrets";
import {
  projectSupplierOfferForAdmin,
  applyApprovedSupplierInventoryObservation,
  SupplierProductOffer,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "../api/suppliers/supplierOfferEngine";
import {
  resolveProvenSupplierLocalDemand,
} from "../api/orders/supplierInventoryReconciliation";
import { SupplierConnector, SupplierInventoryObservation } from "../api/suppliers/types";
import { SupplierRegistry } from "../api/suppliers/SupplierRegistry";

export const DROPEX_INVENTORY_REFRESH_SCHEDULE = "every 15 minutes";
export const DROPEX_INVENTORY_REFRESH_BATCH_SIZE = 100;
export const DROPEX_INVENTORY_REFRESH_SCAN_LIMIT = 120;
export const DROPEX_INVENTORY_REFRESH_LEASE_MS = 8 * 60 * 1000;
/** No new supplier request starts after this; one request is bounded by ~45s of timeouts, inside the 540s function timeout. */
export const DROPEX_INVENTORY_REFRESH_RUNTIME_BUDGET_MS = 7 * 60 * 1000;
export const DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID = "source-dropex";

const SOURCE_ID = "dropex";
const PRODUCTS_COLLECTION = "products";
const PRIVATE_PRODUCTS_COLLECTION = "product_private";

export interface SupplierInventoryRefreshSummary {
  runId: string;
  skipped: boolean;
  attempted: number;
  updated: number;
  unchanged: number;
  skippedItems: number;
  failed: number;
  cursor: string | null;
  truncated: boolean;
}

interface RefreshLease {
  acquired: boolean;
  cursor: string | null;
}

interface InventoryRefreshTarget {
  documentId: string;
  offer: SupplierProductOffer;
  productId: string;
  supplierProductId: string;
  sku: string;
}

type SourceConnectorFactory = (
  sourceId: string,
  source: FirebaseFirestore.DocumentData,
) => Promise<SupplierConnector>;

const identity = (value: unknown): string => String(value || "").normalize("NFKC").trim();
const identityLower = (value: unknown): string => identity(value).toLocaleLowerCase();
const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const isLeaseActive = (value: unknown, now: number): boolean => {
  const expiresAt = Date.parse(String(value || ""));
  return Number.isFinite(expiresAt) && expiresAt > now;
};

async function acquireRefreshLease(db: Firestore, owner: string, now: number): Promise<RefreshLease> {
  const reference = db.collection("supplier_sync_locks").doc(DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.data() || {};
    if (current.status === "running" && isLeaseActive(current.lockedUntil, now)) {
      return { acquired: false, cursor: null };
    }
    const cursor = identity(current.inventoryRefreshCursor) || null;
    transaction.set(reference, {
      status: "running",
      owner,
      sourceId: SOURCE_ID,
      refreshMode: "inventory_only",
      startedAt: new Date(now).toISOString(),
      lockedUntil: new Date(now + DROPEX_INVENTORY_REFRESH_LEASE_MS).toISOString(),
      inventoryRefreshRunId: owner,
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
    return { acquired: true, cursor };
  });
}

async function heartbeatRefreshLease(db: Firestore, owner: string, now: number): Promise<boolean> {
  const reference = db.collection("supplier_sync_locks").doc(DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.data() || {};
    if (current.status !== "running" || current.owner !== owner) return false;
    transaction.set(reference, {
      lockedUntil: new Date(now + DROPEX_INVENTORY_REFRESH_LEASE_MS).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
    return true;
  });
}

async function releaseRefreshLease(
  db: Firestore,
  owner: string,
  cursor: string | null,
  summary: SupplierInventoryRefreshSummary,
  now: number,
): Promise<void> {
  const reference = db.collection("supplier_sync_locks").doc(DROPEX_INVENTORY_REFRESH_SOURCE_LOCK_ID);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.data()?.owner !== owner) return;
    transaction.set(reference, {
      status: "idle",
      activeSyncCount: 0,
      finishedAt: new Date(now).toISOString(),
      inventoryRefreshCursor: cursor,
      inventoryRefreshLastRun: summary,
      lockedUntil: FieldValue.delete(),
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
  });
}

function targetFromSnapshots(
  documentId: string,
  offer: SupplierProductOffer | null,
  productId: string,
  productValue: unknown,
  privateValue: unknown,
): InventoryRefreshTarget | null {
  if (!offer
    || offer.sourceId !== SOURCE_ID
    || offer.supplierId !== SOURCE_ID
    || offer.reviewStatus !== "approved"
    || offer.enabled !== true
    || offer.productId !== productId) return null;

  const product = record(productValue);
  if (product.isActive !== true) return null;
  const privateProduct = record(privateValue);
  const metadata = record(privateProduct.supplierMetadata);
  const selection = record(privateProduct.supplierOfferSelection);
  const privateSource = identityLower(privateProduct.supplierSourceId || privateProduct.supplierId || metadata.supplierSourceId);
  const privateProductId = identity(metadata.supplierProductId);
  const privateSku = identity(metadata.sku || privateProduct.supplierItemCode);
  const publicSource = identityLower(product.supplierSourceId || product.supplierId);
  const publicSku = identity(product.supplierItemCode);
  const localDemand = resolveProvenSupplierLocalDemand(privateValue, product.stock);

  if (privateSource !== SOURCE_ID
    || (publicSource && publicSource !== SOURCE_ID)
    || selection.activeOfferId !== offer.id
    || metadata.activeOfferId !== offer.id
    || (selection.lockedOfferId && selection.lockedOfferId !== offer.id)
    || !privateProductId
    || !privateSku
    || identityLower(privateProductId) !== identityLower(offer.supplierProductId)
    || identityLower(privateSku) !== identityLower(offer.sku)
    || (publicSku && identityLower(publicSku) !== identityLower(offer.sku))
    || !localDemand
    || localDemand.status !== "tracked") return null;

  return {
    documentId,
    offer,
    productId,
    supplierProductId: identity(offer.supplierProductId),
    sku: identity(offer.sku),
  };
}

async function loadRefreshPage(
  db: Firestore,
  cursor: string | null,
  limit: number,
): Promise<{ targets: InventoryRefreshTarget[]; skipped: number; nextCursor: string | null }> {
  let query = db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION)
    .where("sourceId", "==", SOURCE_ID)
    .where("reviewStatus", "==", "approved")
    .where("enabled", "==", true)
    .orderBy(FieldPath.documentId(), "asc")
    .limit(DROPEX_INVENTORY_REFRESH_SCAN_LIMIT);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const targets: InventoryRefreshTarget[] = [];
  let skipped = 0;
  let lastExamined: string | null = null;
  let filled = false;

  for (const offerDocument of snapshot.docs) {
    if (targets.length >= limit) {
      filled = true;
      break;
    }
    lastExamined = offerDocument.id;
    const offer = projectSupplierOfferForAdmin({ id: offerDocument.id, ...offerDocument.data() });
    const productId = identity(offer?.productId);
    if (!offer || !productId || offer.reviewStatus !== "approved" || offer.enabled !== true) {
      skipped += 1;
      continue;
    }
    const [productSnapshot, privateSnapshot] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).doc(productId).get(),
      db.collection(PRIVATE_PRODUCTS_COLLECTION).doc(productId).get(),
    ]);
    const target = targetFromSnapshots(
      offerDocument.id,
      offer,
      productId,
      productSnapshot.exists ? productSnapshot.data() : undefined,
      privateSnapshot.exists ? privateSnapshot.data() : undefined,
    );
    if (!target) skipped += 1;
    else targets.push(target);
  }

  const nextCursor = filled || snapshot.docs.length === DROPEX_INVENTORY_REFRESH_SCAN_LIMIT
    ? lastExamined
    : null;
  return { targets, skipped, nextCursor };
}

const exactInventoryConnector = (connector: SupplierConnector): SupplierConnector & {
  fetchExactInventoryForRefresh: (target: { supplierProductId: string; sku: string }) => Promise<SupplierInventoryObservation>;
} => {
  if (typeof connector.fetchExactInventoryForRefresh !== "function") {
    throw new Error("Dropex does not support exact inventory refresh.");
  }
  return connector as SupplierConnector & {
    fetchExactInventoryForRefresh: (target: { supplierProductId: string; sku: string }) => Promise<SupplierInventoryObservation>;
  };
};

export async function runDropexInventoryRefresh(
  now = Date.now(),
  db: Firestore = adminDb,
  batchSize = DROPEX_INVENTORY_REFRESH_BATCH_SIZE,
  connectorFactory: SourceConnectorFactory = (sourceId, source) => SupplierRegistry.createConnectorForSourceRecord(sourceId, source),
): Promise<SupplierInventoryRefreshSummary> {
  const boundedBatchSize = Math.max(1, Math.min(Math.floor(batchSize), DROPEX_INVENTORY_REFRESH_BATCH_SIZE));
  const runId = `dropex-inventory-${now}`;
  const summary: SupplierInventoryRefreshSummary = {
    runId,
    skipped: false,
    attempted: 0,
    updated: 0,
    unchanged: 0,
    skippedItems: 0,
    failed: 0,
    cursor: null,
    truncated: false,
  };
  const startedAt = Date.now();
  const lease = await acquireRefreshLease(db, runId, now);
  if (!lease.acquired) return { ...summary, skipped: true };
  let nextCursor = lease.cursor;

  try {
    const sourceSnapshot = await db.collection("supplierSources").doc(SOURCE_ID).get();
    const source = sourceSnapshot.exists ? sourceSnapshot.data() || {} : {};
    const sourceStatus = identityLower(source.sourceStatus);
    if (!sourceSnapshot.exists
      || source.enabled === false
      || source.currentlySyncing === true
      || ["inactive", "disabled"].includes(sourceStatus)) {
      summary.skipped = true;
      return summary;
    }

    const page = await loadRefreshPage(db, lease.cursor, boundedBatchSize);
    summary.skippedItems += page.skipped;
    nextCursor = page.nextCursor;
    summary.truncated = page.nextCursor !== null;
    if (page.targets.length === 0) return summary;

    const connector = exactInventoryConnector(await connectorFactory(SOURCE_ID, source));
    let lastProcessedDocumentId: string | null = null;
    for (const target of page.targets) {
      if (Date.now() - startedAt >= DROPEX_INVENTORY_REFRESH_RUNTIME_BUDGET_MS) {
        nextCursor = lastProcessedDocumentId ?? lease.cursor;
        summary.truncated = true;
        appLogger.warn("Scheduled Dropex inventory refresh reached its runtime budget; continuing next run.", { runId });
        break;
      }
      summary.attempted += 1;
      if (!await heartbeatRefreshLease(db, runId, Date.now())) {
        summary.failed += 1;
        summary.truncated = true;
        appLogger.warn("Scheduled Dropex inventory refresh lease was lost; stopping the run.", { runId });
        break;
      }
      lastProcessedDocumentId = target.documentId;
      try {
        const observation = await connector.fetchExactInventoryForRefresh({
          supplierProductId: target.supplierProductId,
          sku: target.sku,
        });
        if (identityLower(observation.supplierProductId) !== identityLower(target.supplierProductId)
          || identityLower(observation.sku) !== identityLower(target.sku)
          || !Number.isSafeInteger(observation.stock)
          || observation.stock < 0) {
          throw new Error("Dropex inventory observation failed the exact identity or stock safety checks.");
        }
        const applied = await applyApprovedSupplierInventoryObservation(db, {
          offerId: target.offer.id,
          productId: target.productId,
          stock: observation.stock,
          observedAt: new Date(Date.now()).toISOString(),
          batchId: runId,
          reason: "Scheduled exact Dropex inventory refresh for an active approved product.",
          expectedStateVersion: target.offer.stateVersion,
          stockOnly: true,
        });
        if (applied.applied) summary.updated += 1;
        else summary.unchanged += 1;
      } catch (error) {
        summary.failed += 1;
        appLogger.warn("Scheduled Dropex inventory refresh item failed.", {
          runId,
          offerId: target.offer.id,
          productId: target.productId,
          reason: error instanceof Error ? error.message : String(error || "Unknown inventory refresh failure."),
        });
      }
    }
    return summary;
  } catch (error) {
    summary.failed += 1;
    appLogger.error("Scheduled Dropex inventory refresh failed.", {
      runId,
      reason: error instanceof Error ? error.message : String(error || "Unknown inventory refresh failure."),
    });
    return summary;
  } finally {
    summary.cursor = nextCursor;
    await releaseRefreshLease(db, runId, nextCursor, summary, Date.now());
    if (summary.truncated) {
      appLogger.warn("Scheduled Dropex inventory refresh did not cover every candidate this run.", { runId, cursor: nextCursor });
    }
    appLogger.info("Scheduled Dropex inventory refresh finished.", { ...summary });
  }
}

export const scheduledSupplierInventoryRefresh = onSchedule({
  schedule: DROPEX_INVENTORY_REFRESH_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: DROPEX_SECRETS,
}, async () => {
  await runDropexInventoryRefresh();
});
