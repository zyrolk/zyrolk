import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import {
  acquireSupplierManagedMedia,
  applyManagedMediaToProductPayload,
  MAX_SUPPLIER_IMAGE_BYTES,
  MAX_SUPPLIER_GALLERY_IMAGES,
  orderSupplierManagedMedia,
  SupplierManagedMediaAsset,
  SupplierMediaPipelineDependencies,
  SupplierMediaRetryableError,
  supplierMediaRetryDelayMs,
  toPublishedProductMedia,
  validateSupplierImageMimeType,
  validateSupplierMediaUrl,
} from "../functions/src/api/suppliers/supplierMediaPipeline";
import type { SupplierOutboundResponse } from "../functions/src/api/security/supplierOutboundRequest";

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pngBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);

const response = (body: Buffer, contentType = "image/png", status = 200): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": contentType, "content-length": String(body.length) }),
  text: async () => body.toString("utf8"),
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  json: async <T>() => JSON.parse(body.toString("utf8")) as T,
});

const asset = (overrides: Partial<SupplierManagedMediaAsset> = {}): SupplierManagedMediaAsset => ({
  assetId: "a".repeat(64),
  supplierId: "supplier-a",
  sourceId: "source-a",
  productId: "product-a",
  originalSupplierUrl: "https://supplier.example/image.png",
  originalStoragePath: `supplier-media/supplier-a/product-a/${"a".repeat(64)}/original/image.png`,
  originalStorageUrl: "https://storage.example/original",
  firebaseStorageUrl: "https://storage.example/large",
  contentHash: "a".repeat(64),
  width: 2,
  height: 2,
  mimeType: "image/png",
  fileSize: pngBody.length,
  uploadTimestamp: "2026-07-24T00:00:00.000Z",
  imageStatus: "ready",
  isPrimary: true,
  sortOrder: 0,
  variants: {
    thumbnail: { storagePath: "thumbnail", storageUrl: "https://storage.example/thumbnail", width: 1, height: 1, mimeType: "image/webp", fileSize: 10 },
    medium: { storagePath: "medium", storageUrl: "https://storage.example/medium", width: 1, height: 1, mimeType: "image/webp", fileSize: 10 },
    large: { storagePath: "large", storageUrl: "https://storage.example/large", width: 1, height: 1, mimeType: "image/webp", fileSize: 10 },
  },
  ...overrides,
});

const dependencies = (overrides: Partial<SupplierMediaPipelineDependencies> = {}): {
  dependencies: SupplierMediaPipelineDependencies;
  savedFiles: Array<{ path: string; body: Buffer; contentType: string }>;
  savedAssets: SupplierManagedMediaAsset[];
  audits: Array<Record<string, unknown>>;
} => {
  const savedFiles: Array<{ path: string; body: Buffer; contentType: string }> = [];
  const savedAssets: SupplierManagedMediaAsset[] = [];
  const audits: Array<Record<string, unknown>> = [];
  return {
    savedFiles,
    savedAssets,
    audits,
    dependencies: {
      fetchImage: async () => response(pngBody),
      findAsset: async () => null,
      saveFile: async (path, body, contentType) => {
        savedFiles.push({ path, body, contentType });
        return `https://storage.example/${encodeURIComponent(path)}`;
      },
      saveAsset: async (value) => { savedAssets.push(value); },
      recordAudit: async (event) => { audits.push(event); },
      ...overrides,
    },
  };
};

const request = {
  queueItemId: "queue-a",
  supplierId: "supplier-a",
  sourceId: "source-a",
  productId: "product-a",
  imageUrls: ["https://supplier.example/catalog/image.png"],
  now: Date.parse("2026-07-24T00:00:00.000Z"),
};

test("Sprint 6 securely downloads, hashes, optimizes, and persists supplier media", async () => {
  const fixture = dependencies();
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);

  assert.equal(result.failures.length, 0);
  assert.equal(result.assets.length, 1);
  assert.equal(fixture.savedFiles.length, 4, "original plus thumbnail, medium, and large must be stored");
  assert.equal(fixture.savedAssets.length, 1);
  assert.match(result.assets[0].contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.assets[0].mimeType, "image/png");
  assert.equal(result.assets[0].width, 2);
  assert.equal(result.assets[0].height, 2);
  assert.equal(result.assets[0].fileSize, pngBody.length);
  assert.equal(result.assets[0].imageStatus, "ready");
  assert.equal(result.assets[0].variants.thumbnail.mimeType, "image/webp");
  assert.ok(result.assets[0].variants.thumbnail.fileSize > 0);
  assert.match(result.assets[0].originalStoragePath, /^supplier-media\/supplier-a\/product-a\/[a-f0-9]{64}\/original\/image\.png$/u);
  assert.equal(fixture.audits.some((entry) => entry.event === "supplier_media_acquired"), true);
});

test("Sprint 6 rejects non-HTTPS and unsupported MIME values without retrying", async () => {
  assert.throws(() => validateSupplierMediaUrl("http://supplier.example/image.jpg"), /HTTPS/u);
  assert.throws(() => validateSupplierMediaUrl("file:///etc/passwd"), /HTTPS/u);
  assert.throws(() => validateSupplierImageMimeType("image/svg+xml"), /not supported/u);

  let fetched = false;
  const fixture = dependencies({ fetchImage: async () => { fetched = true; return response(pngBody); } });
  const result = await acquireSupplierManagedMedia({} as Firestore, {
    ...request,
    imageUrls: ["http://supplier.example/image.png"],
  }, fixture.dependencies);
  assert.equal(fetched, false);
  assert.equal(result.assets.length, 0);
  assert.equal(result.failures[0].retryable, false);
});

test("Sprint 6 rejects declared MIME that does not match decoded image content", async () => {
  const fixture = dependencies({ fetchImage: async () => response(pngBody, "image/jpeg") });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.assets.length, 0);
  assert.match(result.failures[0].reason, /does not match/u);
  assert.equal(fixture.savedFiles.length, 0);
});

test("Sprint 6 rejects images whose declared size exceeds the production limit", async () => {
  const oversizedResponse = response(pngBody);
  oversizedResponse.headers.set("content-length", String(MAX_SUPPLIER_IMAGE_BYTES + 1));
  const fixture = dependencies({ fetchImage: async () => oversizedResponse });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.assets.length, 0);
  assert.match(result.failures[0].reason, /maximum allowed size/u);
  assert.equal(result.failures[0].retryable, false);
  assert.equal(fixture.savedFiles.length, 0);
});

test("Sprint 6 reuses content-addressed duplicate media without uploading again", async () => {
  const existing = asset();
  const fixture = dependencies({ findAsset: async () => existing });
  const result = await acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.assets[0].contentHash, existing.contentHash);
  assert.equal(fixture.savedFiles.length, 0);
  assert.equal(fixture.savedAssets.length, 0);
  assert.equal(fixture.audits.some((entry) => entry.event === "supplier_media_reused"), true);
});

test("Sprint 6 preserves primary/gallery order and enforces the gallery maximum", () => {
  const values = Array.from({ length: MAX_SUPPLIER_GALLERY_IMAGES + 3 }, (_, index) => asset({
    assetId: String(index).padStart(64, "0"),
    contentHash: String(index).padStart(64, "0"),
    firebaseStorageUrl: `https://storage.example/${index}`,
    sortOrder: MAX_SUPPLIER_GALLERY_IMAGES + 2 - index,
    isPrimary: false,
  }));
  const ordered = orderSupplierManagedMedia(values);
  assert.equal(ordered.length, MAX_SUPPLIER_GALLERY_IMAGES);
  assert.equal(ordered[0].isPrimary, true);
  assert.equal(ordered.filter((entry) => entry.isPrimary).length, 1);
  assert.deepEqual(ordered.map((entry) => entry.sortOrder), Array.from({ length: MAX_SUPPLIER_GALLERY_IMAGES }, (_, index) => index));
});

test("Sprint 6 sends transient download failures into exponential retry handling", async () => {
  const fixture = dependencies({ fetchImage: async () => { throw new Error("socket timeout"); } });
  await assert.rejects(
    acquireSupplierManagedMedia({} as Firestore, request, fixture.dependencies),
    (error: unknown) => error instanceof SupplierMediaRetryableError && error.failures[0].retryable,
  );
  assert.deepEqual([1, 2, 3, 8].map(supplierMediaRetryDelayMs), [30_000, 60_000, 120_000, 3_600_000]);
  assert.equal(fixture.audits.some((entry) => entry.event === "supplier_media_failed"), true);
});

test("Sprint 6 approval projection publishes managed URLs without exposing supplier URLs", () => {
  const managed = asset();
  const product = applyManagedMediaToProductPayload({ id: "product-a", name: "Product" }, [managed]);
  const published = toPublishedProductMedia([managed]);
  assert.equal(product.imageUrl, managed.firebaseStorageUrl);
  assert.deepEqual(product.imageUrls, [managed.firebaseStorageUrl]);
  assert.equal(published[0].imageStatus, "published");
  assert.equal("originalSupplierUrl" in published[0], false);

  const approvalSource = projectFile("functions/src/api/suppliers/supplierApproval.ts");
  assert.match(approvalSource, /valid managed product image is required before publishing/u);
  assert.match(approvalSource, /SUPPLIER_MEDIA_COLLECTION/u);
  assert.match(approvalSource, /publishCount: FieldValue\.increment/u);
});

test("Sprint 6 Storage and Firestore rules keep uploads server-only", () => {
  const storageRules = projectFile("storage.rules");
  const firestoreRules = projectFile("firestore.rules");
  assert.match(storageRules, /match \/supplier-media\/\{supplierId\}\/\{productId\}\/\{assetId\}\/\{variant\}\/\{fileName\}/u);
  assert.match(storageRules, /allow create, update, delete: if false/u);
  assert.match(storageRules, /imageStatus == 'published'/u);
  assert.match(storageRules, /variant != 'original'/u);
  assert.match(firestoreRules, /match \/supplier_media_assets\/\{docId\}[\s\S]*?allow create, update, delete: if false/u);
  assert.match(firestoreRules, /match \/supplier_media_audit\/\{docId\}[\s\S]*?allow create, update, delete: if false/u);
});

test("Sprint 6 retains Sprint 1-5 onboarding, concurrency, traversal, mapping, and import paths", () => {
  const sync = projectFile("functions/src/scheduled/supplierSync.ts");
  const queue = projectFile("functions/src/scheduled/supplierReviewQueue.ts");
  const approval = projectFile("functions/src/api/suppliers/supplierApproval.ts");
  assert.match(projectFile("functions/src/api/suppliers/SupplierRegistry.ts"), /createConnector/u);
  assert.match(approval, /detectSupplierApprovalConflict/u);
  assert.match(sync, /runSupplierCatalogTraversal/u);
  assert.match(sync, /suggestSupplierCategory/u);
  assert.match(sync, /mergeSupplierProductMetadata/u);
  assert.match(queue, /ensureSupplierReviewQueueManagedMedia/u);
  assert.match(queue, /buildSupplierQueueFailureUpdate/u);
});
