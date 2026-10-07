import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierReviewBusinessQueueProjection,
  reviewRecordMatchesBusinessFilter,
  supplierReviewQueueMediaIsReady,
} from "../functions/src/scheduled/supplierReviewQueue";
import {
  isSupplierReviewBusinessProjectionMigrationRequired,
  isSupplierReviewBusinessProjectionStatusActive,
  migrationCheckpointForProjectionVersion,
  SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
} from "../functions/src/api/suppliers/supplierReviewBusinessQueueProjection";

const baseRecord = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "Pending",
  queueState: "review_pending",
  sourceId: "dropex",
  comparisonStatus: "NEW_PRODUCT",
  comparison: { comparisonStatus: "NEW_PRODUCT", changedFields: [] },
  productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  productPayload: { category: "", stock: 10 },
  stock: 10,
  supplierSnapshot: {
    inventoryLevel: 10,
    providedFields: ["stock"],
    supplierMetadata: { supplierStockAvailable: true },
  },
  ...patch,
});

test("business projection preserves the existing overlapping queue semantics", () => {
  const actionableNew = baseRecord();
  const projection = buildSupplierReviewBusinessQueueProjection(actionableNew as never);
  assert.deepEqual(projection.businessQueueClasses, ["actionable", "new_products"]);
  assert.equal(reviewRecordMatchesBusinessFilter(actionableNew as never, "actionable"), true);
  assert.equal(reviewRecordMatchesBusinessFilter(actionableNew as never, "new_products"), true);

  const attention = baseRecord({
    comparisonStatus: "DESCRIPTION_CHANGED",
    comparison: { comparisonStatus: "DESCRIPTION_CHANGED", changedFields: ["Description"] },
    productValidation: { readyToPublish: false, missingFields: ["category"], errors: [{ code: "required" }] },
  });
  assert.deepEqual(buildSupplierReviewBusinessQueueProjection(attention as never).businessQueueClasses, [
    "actionable", "product_updates", "needs_attention",
  ]);

  const lowStock = baseRecord({ stock: 2, productPayload: { category: "", stock: 2 } });
  assert.deepEqual(buildSupplierReviewBusinessQueueProjection(lowStock as never).businessQueueClasses, [
    "low_stock_hold",
  ]);

  const history = baseRecord({ status: "Approved", queueState: "approved", comparisonStatus: "UNCHANGED" });
  assert.deepEqual(buildSupplierReviewBusinessQueueProjection(history as never).businessQueueClasses, ["approved_history"]);
});

test("business queue projection is a read model and does not replace approval or media authority", () => {
  const source = readFileSync("functions/src/scheduled/supplierReviewQueue.ts", "utf8");
  const migration = readFileSync("scripts/migrateSupplierReviewBusinessQueueProjection.ts", "utf8");
  assert.match(source, /SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_FIELD = "businessQueueClasses"/u);
  assert.match(source, /array-contains/u);
  assert.match(source, /reviewPageReadQuery\([\s\S]*?\.count\(\)\.get\(\)/u);
  assert.match(migration, /projection-field-only/u);
  assert.match(migration, /no-product-business-data-rewrite/u);
  assert.match(migration, /MAX_BATCHES_PER_INVOCATION = 25/u);
  assert.match(migration, /PAGE_SIZE = 200/u);
});

test("projection activation is version-fenced and active v1 requires migration", () => {
  const activeV1 = {
    status: "active" as const,
    version: 1,
    scanned: 6383,
    projected: 6383,
    lastDocumentId: null,
  };
  const activeV2 = { ...activeV1, version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION };

  assert.equal(isSupplierReviewBusinessProjectionStatusActive(activeV1), false);
  assert.equal(isSupplierReviewBusinessProjectionMigrationRequired(activeV1), true);
  assert.equal(isSupplierReviewBusinessProjectionStatusActive(activeV2), true);
  assert.equal(isSupplierReviewBusinessProjectionMigrationRequired(activeV2), false);
  assert.deepEqual(migrationCheckpointForProjectionVersion(activeV1), {
    scanned: 0,
    projected: 0,
    lastDocumentId: null,
  });
});

test("only a pending v2 checkpoint resumes; v1 checkpoints restart safely", () => {
  const pendingV2 = {
    status: "pending" as const,
    version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
    scanned: 400,
    projected: 120,
    lastDocumentId: "review-0400",
  };
  assert.deepEqual(migrationCheckpointForProjectionVersion(pendingV2), {
    scanned: 400,
    projected: 120,
    lastDocumentId: "review-0400",
  });
  assert.deepEqual(migrationCheckpointForProjectionVersion({ ...pendingV2, version: 1 }), {
    scanned: 0,
    projected: 0,
    lastDocumentId: null,
  });
});

test("migration source keeps bounded projection-only v2 activation guarantees", () => {
  const migration = readFileSync("scripts/migrateSupplierReviewBusinessQueueProjection.ts", "utf8");
  assert.match(migration, /isSupplierReviewBusinessProjectionMigrationRequired\(existing\)/u);
  assert.match(migration, /canResumeExistingCheckpoint/u);
  assert.match(migration, /status: "active"[\s\S]*version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION/u);
  assert.match(migration, /PAGE_SIZE = 200/u);
  assert.match(migration, /MAX_BATCHES_PER_INVOCATION = 25/u);
  assert.match(migration, /projection-field-only/u);
  assert.match(migration, /no-product-business-data-rewrite/u);
});

test("ready_for_review is only projected when the complete server proposal and managed media are publish-safe", () => {
  const managedMedia = [{
    contentHash: "a".repeat(64),
    firebaseStorageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media",
    originalSupplierUrl: "https://supplier.example/image.webp",
    imageStatus: "ready",
    isPrimary: true,
    storagePath: "supplier-review/demo/managed.webp",
    variants: { large: { firebaseStorageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media" } },
  }];
  const complete = baseRecord({
    mediaStatus: "ready",
    mediaReadiness: "publication_safe",
    mediaQueueClass: "ready",
    mediaSourceImageUrls: ["https://supplier.example/image.webp"],
    managedMedia,
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    productPayload: { category: "category-1", subcategory: "subcategory-1", stock: 10 },
  });
  assert.equal(supplierReviewQueueMediaIsReady(managedMedia), true);
  assert.equal(reviewRecordMatchesBusinessFilter(complete as never, "ready_for_review"), true);
  assert.ok((buildSupplierReviewBusinessQueueProjection(complete as never).businessQueueClasses as string[]).includes("ready_for_review"));

  const missingCategory = {
    ...complete,
    productValidation: { readyToPublish: false, missingFields: ["category"], errors: [{ field: "category", code: "required" }] },
  };
  assert.equal(reviewRecordMatchesBusinessFilter(missingCategory as never, "ready_for_review"), false);

  const rawOnly = {
    ...complete,
    mediaStatus: "ready",
    mediaReadiness: "publication_safe",
    mediaQueueClass: "ready",
    managedMedia: [{ firebaseStorageUrl: "https://supplier.example/image.webp", isPrimary: true }],
  };
  assert.equal(supplierReviewQueueMediaIsReady(rawOnly.managedMedia), false);
  assert.equal(reviewRecordMatchesBusinessFilter(rawOnly as never, "ready_for_review"), false);
});
