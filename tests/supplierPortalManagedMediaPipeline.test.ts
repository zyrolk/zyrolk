import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupplierOutboundResponse } from "../functions/src/api/security/supplierOutboundRequest";
import {
  SupplierManagedMediaAsset,
  SupplierMediaPipelineDependencies,
  SupplierMediaRetryableError,
  SupplierMediaValidationError,
} from "../functions/src/api/suppliers/supplierMediaPipeline";
import {
  buildSupplierQueueFailureUpdate,
  buildSupplierQueueLifecycle,
  ensureSupplierReviewQueueManagedMedia,
  processSupplierReviewQueueItem,
} from "../functions/src/scheduled/supplierReviewQueue";

type StoredDocument = Record<string, unknown>;

const pngBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);
const changedPngBody = Buffer.concat([pngBody, Buffer.from("changed-image-content")]);

const response = (status = 200, body = pngBody): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": "image/png", "content-length": String(body.length) }),
  text: async () => body.toString("utf8"),
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  json: async <T>() => JSON.parse(body.toString("utf8")) as T,
});

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  let generatedId = 0;
  type Reference = ReturnType<typeof reference>;
  function reference(collectionName: string, id: string) {
    const key = `${collectionName}/${id}`;
    return {
      collectionName,
      id,
      key,
      get: async () => snapshot(key, id),
      set: async (data: StoredDocument, options?: { merge?: boolean }) => {
        documents.set(key, options?.merge ? { ...(documents.get(key) || {}), ...data } : data);
      },
    };
  }
  const snapshot = (key: string, id: string) => ({
    id,
    exists: documents.has(key),
    data: () => documents.get(key),
  });
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => reference(collectionName, id || `generated-${++generatedId}`),
    }),
    runTransaction: async <T>(operation: (transaction: {
      get: (ref: Reference) => Promise<ReturnType<typeof snapshot>>;
      set: (ref: Reference, data: StoredDocument, options?: { merge?: boolean }) => void;
      create: (ref: Reference, data: StoredDocument) => void;
    }) => Promise<T>) => operation({
      get: async (ref) => snapshot(ref.key, ref.id),
      set: (ref, data, options) => {
        documents.set(ref.key, options?.merge ? { ...(documents.get(ref.key) || {}), ...data } : data);
      },
      create: (ref, data) => {
        if (documents.has(ref.key)) throw new Error("Audit event already exists");
        documents.set(ref.key, data);
      },
    }),
  };
  return { db, documents };
};

const queueRecord = (id: string, productId: string, imageUrl: string): StoredDocument => ({
  id,
  portalRequestId: id.replace(/^portal-/u, ""),
  connector: "supplier_portal",
  sourceId: "supplier-portal",
  supplierId: "supplier-a",
  productId,
  managedMediaRequired: true,
  mediaStatus: "queued",
  status: "Pending",
  productPayload: { id: productId, imageUrl, imageUrls: [] },
  supplierSnapshot: { supplierId: "supplier-a", sourceId: "supplier-portal", mediaGallery: [imageUrl] },
  productValidation: {
    readyToPublish: false,
    missingFields: ["images"],
    errors: [{ field: "images", code: "managed_media_required", message: "Managed media is pending." }],
  },
  ...buildSupplierQueueLifecycle(new Date(Date.now() - 1_000).toISOString()),
});

test("Supplier Portal queue uses the canonical media worker before becoming review-ready", async () => {
  const imageUrl = "https://supplier.example/product.png";
  const { db, documents } = createFakeFirestore({
    "supplier_review_queue/portal-new": queueRecord("portal-new", "new-product", imageUrl),
  });
  const storageWrites: string[] = [];
  const mediaAudits: Array<Record<string, unknown>> = [];
  const dependencies: SupplierMediaPipelineDependencies = {
    fetchImage: async (url) => response(200, url.includes("changed-product") ? changedPngBody : pngBody),
    findAsset: async (contentHash) => documents.get(`supplier_media_assets/${contentHash}`) as unknown as SupplierManagedMediaAsset | undefined || null,
    saveFile: async (storagePath) => {
      storageWrites.push(storagePath);
      return `https://firebasestorage.googleapis.com/v0/b/test/o/${encodeURIComponent(storagePath)}?alt=media`;
    },
    saveAsset: async (asset) => { documents.set(`supplier_media_assets/${asset.assetId}`, asset as unknown as StoredDocument); },
    recordAudit: async (event) => { mediaAudits.push(event); },
  };

  const processed = await processSupplierReviewQueueItem(
    db as never,
    "portal-new",
    "portal-media-worker",
    Date.now(),
    { mediaDependencies: dependencies },
  );
  assert.deepEqual(processed, { queueItemId: "portal-new", outcome: "completed", state: "review_pending" });
  const ready = documents.get("supplier_review_queue/portal-new")!;
  const managed = ready.managedMedia as SupplierManagedMediaAsset[];
  assert.equal(ready.queueState, "review_pending");
  assert.equal(ready.mediaStatus, "ready");
  assert.equal((ready.productValidation as StoredDocument).readyToPublish, true);
  assert.equal(managed.length, 1);
  assert.match(managed[0].firebaseStorageUrl, /^https:\/\/firebasestorage\.googleapis\.com\//u);
  assert.equal([...documents.keys()].filter((key) => key.startsWith("supplier_media_assets/")).length, 1);
  assert.equal(storageWrites.length, 4, "one original and three managed variants are written");
  assert.equal(mediaAudits.some((entry) => entry.event === "supplier_media_acquired"), true);

  const duplicateRun = await processSupplierReviewQueueItem(
    db as never,
    "portal-new",
    "duplicate-worker",
    Date.now(),
    { mediaDependencies: dependencies },
  );
  assert.equal(duplicateRun.outcome, "skipped");
  assert.equal(storageWrites.length, 4);

  documents.set(
    "supplier_review_queue/portal-change",
    {
      ...queueRecord("portal-change", "existing-product", "https://supplier.example/changed-product.png"),
      comparisonStatus: "IMAGE_CHANGED",
      matchedProductId: "existing-product",
    },
  );
  const changed = await processSupplierReviewQueueItem(
    db as never,
    "portal-change",
    "portal-change-worker",
    Date.now(),
    { mediaDependencies: dependencies },
  );
  assert.equal(changed.state, "review_pending");
  assert.equal(documents.get("supplier_review_queue/portal-change")?.productId, "existing-product");
  assert.equal(storageWrites.length, 8, "an image change creates one new original and variant set");
  assert.equal([...documents.keys()].filter((key) => key.startsWith("supplier_media_assets/")).length, 2);

  documents.set("supplier_review_queue/portal-unchanged", {
    ...queueRecord("portal-unchanged", "existing-product", imageUrl),
    comparisonStatus: "FULL_PRODUCT_CHANGE",
    matchedProductId: "existing-product",
    managedMedia: managed,
    mediaStatus: "ready",
  });
  const unchanged = await processSupplierReviewQueueItem(
    db as never,
    "portal-unchanged",
    "portal-unchanged-worker",
    Date.now(),
    { mediaDependencies: dependencies },
  );
  assert.equal(unchanged.state, "review_pending");
  assert.equal(documents.get("supplier_review_queue/portal-unchanged")?.productId, "existing-product");
  assert.equal(storageWrites.length, 8, "unchanged media reuses the already-managed asset");
  assert.equal([...documents.keys()].filter((key) => key.startsWith("supplier_media_assets/")).length, 2);
});

test("Supplier Portal media failures persist diagnostics and cannot become review-ready", async () => {
  const imageUrl = "https://supplier.example/unreachable.png";
  const { db, documents } = createFakeFirestore({
    "supplier_review_queue/portal-failure": queueRecord("portal-failure", "failed-product", imageUrl),
  });
  const dependencies: SupplierMediaPipelineDependencies = {
    fetchImage: async () => response(503),
    findAsset: async () => null,
    saveFile: async () => { throw new Error("Storage must not be called after a failed download."); },
    saveAsset: async () => { throw new Error("No failed asset may be persisted."); },
    recordAudit: async () => undefined,
  };

  let failure: unknown;
  try {
    await ensureSupplierReviewQueueManagedMedia(db as never, "portal-failure", { dependencies });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure instanceof SupplierMediaRetryableError, true);
  const failed = documents.get("supplier_review_queue/portal-failure")!;
  assert.equal(failed.queueState, "queued");
  assert.equal(failed.mediaStatus, "failed");
  assert.equal((failed.productValidation as StoredDocument).readyToPublish, false);
  assert.equal((failed.mediaFailures as Array<StoredDocument>)[0].retryable, true);
  const retry = buildSupplierQueueFailureUpdate(failed, failure, Date.now());
  assert.equal(retry.state, "retryable_failure");
  assert.match(String(retry.data.lastFailureReason), /will be retried/iu);
  documents.set("supplier_review_queue/portal-failure", { ...failed, ...retry.data });
  assert.equal(documents.get("supplier_review_queue/portal-failure")?.queueState, "retryable_failure");
  assert.notEqual(documents.get("supplier_review_queue/portal-failure")?.queueState, "review_pending");

  const permanent = buildSupplierQueueFailureUpdate(
    failed,
    new SupplierMediaValidationError("Supplier media could not be validated."),
    Date.now(),
  );
  assert.equal(permanent.state, "dead_letter");

  const worker = readFileSync("functions/src/scheduled/supplierReviewQueue.ts", "utf8");
  const approval = readFileSync("functions/src/api/suppliers/supplierApproval.ts", "utf8");
  assert.match(worker, /requiresManagedMedia[\s\S]*managedMediaResult\.assets\.length === 0/u);
  assert.doesNotMatch(worker, /managedMediaResult\.failures\.length > 0/u);
  assert.match(approval, /reviewQueueState !== "review_pending"[\s\S]*not ready for an admin decision/u);
});

test("Partial media success proceeds when at least one managed image is acquired", async () => {
  const goodUrl = "https://supplier.example/good.png";
  const badUrl = "https://supplier.example/bad.png";
  const { db, documents } = createFakeFirestore({
    "supplier_review_queue/portal-partial": {
      ...queueRecord("portal-partial", "partial-product", goodUrl),
      supplierSnapshot: {
        supplierId: "supplier-a",
        sourceId: "supplier-portal",
        mediaGallery: [badUrl, goodUrl],
      },
      productPayload: { id: "partial-product", imageUrl: goodUrl, imageUrls: [badUrl, goodUrl] },
    },
  });
  const dependencies: SupplierMediaPipelineDependencies = {
    fetchImage: async (url) => {
      if (url.includes("bad.png")) throw new Error("Supplier image server returned HTTP 503.");
      return response(200, pngBody);
    },
    findAsset: async (contentHash) => documents.get(`supplier_media_assets/${contentHash}`) as unknown as SupplierManagedMediaAsset | undefined || null,
    saveFile: async (storagePath) => `https://firebasestorage.googleapis.com/v0/b/test/o/${encodeURIComponent(storagePath)}?alt=media`,
    saveAsset: async (asset) => { documents.set(`supplier_media_assets/${asset.assetId}`, asset as unknown as StoredDocument); },
    recordAudit: async () => undefined,
  };

  const processed = await processSupplierReviewQueueItem(
    db as never,
    "portal-partial",
    "partial-media-worker",
    Date.now(),
    { mediaDependencies: dependencies },
  );
  assert.deepEqual(processed, { queueItemId: "portal-partial", outcome: "completed", state: "review_pending" });
  const ready = documents.get("supplier_review_queue/portal-partial")!;
  assert.equal(ready.queueState, "review_pending");
  assert.equal((ready.managedMedia as SupplierManagedMediaAsset[]).length, 1);
  assert.equal((ready.mediaFailures as Array<StoredDocument>).length, 1);
});

test("Retryable media failures escalate to dead-letter after the retry limit", () => {
  const base = {
    ...queueRecord("portal-retry-limit", "retry-product", "https://supplier.example/retry.png"),
    retryCount: 4,
    retryLimit: 5,
  };
  const next = buildSupplierQueueFailureUpdate(
    base,
    new SupplierMediaRetryableError([{
      originalSupplierUrl: "https://supplier.example/retry.png",
      reason: "Supplier image server returned HTTP 503.",
      retryable: true,
      failedAt: new Date().toISOString(),
    }]),
    Date.now(),
  );
  assert.equal(next.state, "dead_letter");
  assert.equal(next.data.retryCount, 5);
});

test("Scheduled queue worker selects queued and retryable_failure by nextRetryAt", () => {
  const worker = readFileSync("functions/src/scheduled/supplierReviewQueue.ts", "utf8");
  const schedule = readFileSync("functions/src/scheduled/supplierQueueWorker.ts", "utf8");
  assert.match(worker, /\["queued", "retryable_failure"\]\.map/u);
  assert.match(worker, /\.where\("nextRetryAt", "<=", nowIso\)/u);
  assert.match(schedule, /scheduledSupplierQueueWorker = onSchedule/u);
  assert.match(schedule, /SUPPLIER_QUEUE_WORKER_SCHEDULE/u);
});

test("Portal submissions enqueue once and preserve already-managed product-change assets", () => {
  const portal = readFileSync("functions/src/api/routes/supplierPortal.ts", "utf8");
  const submit = portal.slice(
    portal.indexOf('app.post("/api/supplier-portal/requests/:requestId/submit"'),
    portal.indexOf('app.post("/api/supplier-portal/products/:productId/stock-proposal"'),
  );
  assert.match(submit, /buildSupplierQueueLifecycle\(observedAt\)/u);
  assert.match(submit, /managedMediaRequired: true/u);
  assert.match(submit, /reusableManagedMedia/u);
  assert.match(submit, /action: "queued"/u);
  assert.doesNotMatch(submit, /action: "review_pending"/u);
  assert.doesNotMatch(submit, /queueState: "review_pending"/u);
  // Same-SKU image edits must observe the submitted draft media, not the prior
  // approved snapshot mediaGallery, or the worker reuses the old content hash.
  assert.match(submit, /supplierSnapshot:\s*\{\s*[\s\S]*?\.\.\.existingOffer\.supplierSnapshot,\s*\.\.\.rawProduct,/u);
  assert.match(submit, /supplierSnapshot:\s*\{\s*[\s\S]*?\.\.\.observedOffer\.supplierSnapshot,\s*\.\.\.rawProduct,/u);
});
