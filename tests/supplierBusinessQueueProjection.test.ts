import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierReviewBusinessQueueProjection,
  reviewRecordMatchesBusinessFilter,
  supplierReviewCategoryRequiresSubcategory,
  supplierReviewReadinessGroupForRecord,
  supplierReviewQueueMediaIsReady,
} from "../functions/src/scheduled/supplierReviewQueue";
import {
  isSupplierReviewBusinessProjectionMigrationRequired,
  isSupplierReviewBusinessProjectionStatusActive,
  migrationCheckpointForProjectionVersion,
  SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
} from "../functions/src/api/suppliers/supplierReviewBusinessQueueProjection";
import {
  canResumeSupplierReviewBusinessProjectionMigration,
  migrationModeFor,
  projectionPatchRequiresWrite,
  supplierReviewProjectionSourceFingerprint,
} from "../scripts/supplierReviewBusinessQueueProjectionMigrationSupport";

const baseRecord = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "Pending",
  queueState: "review_pending",
  sourceId: "dropex",
  comparisonStatus: "NEW_PRODUCT",
  comparison: { comparisonStatus: "NEW_PRODUCT", changedFields: [] },
  productValidation: { readyToPublish: false, missingFields: ["category"], errors: [{ field: "category", code: "required" }] },
  productPayload: { category: "", stock: 10 },
  stock: 10,
  mediaStatus: "ready",
  mediaQueueClass: "ready",
  mediaSourceImageUrls: ["https://supplier.example/image.webp"],
  managedMedia: [{
    contentHash: "a".repeat(64),
    firebaseStorageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media",
    originalSupplierUrl: "https://supplier.example/image.webp",
    imageStatus: "ready",
    isPrimary: true,
    storagePath: "supplier-review/demo/managed.webp",
    variants: { large: { firebaseStorageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media" } },
  }],
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
  assert.deepEqual(projection.businessQueueClasses, ["actionable", "category_decision_required", "new_products"]);
  assert.equal(reviewRecordMatchesBusinessFilter(actionableNew as never, "actionable"), true);
  assert.equal(reviewRecordMatchesBusinessFilter(actionableNew as never, "new_products"), true);

  const attention = baseRecord({
    comparisonStatus: "DESCRIPTION_CHANGED",
    comparison: { comparisonStatus: "DESCRIPTION_CHANGED", changedFields: ["Description"] },
    productValidation: { readyToPublish: false, missingFields: ["category"], errors: [{ field: "category", code: "required" }] },
  });
  assert.deepEqual(buildSupplierReviewBusinessQueueProjection(attention as never).businessQueueClasses, [
    "actionable", "category_decision_required", "product_updates",
  ]);

  const lowStock = baseRecord({ stock: 2, productPayload: { category: "", stock: 2 } });
  assert.deepEqual(buildSupplierReviewBusinessQueueProjection(lowStock as never).businessQueueClasses, [
    "stock_price_issues", "low_stock_hold",
  ]);

  const history = baseRecord({ status: "Approved", queueState: "approved", comparisonStatus: "UNCHANGED" });
  assert.deepEqual(buildSupplierReviewBusinessQueueProjection(history as never).businessQueueClasses, ["approved_history"]);
});

test("new and updated queue records receive v4 fields without replacing approval state", () => {
  const newRecord = baseRecord({ supplierOfferId: "offer-new" });
  const newProjection = buildSupplierReviewBusinessQueueProjection(newRecord as never);
  assert.equal(newProjection.businessQueueClassesVersion, SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION);
  assert.ok(Array.isArray(newProjection.businessQueueClasses));

  const existing = baseRecord({
    supplierOfferId: "offer-existing",
    canonicalProductId: "canonical-1",
    decisionAction: "saved",
    decisionAuditId: "audit-1",
    decisionProductId: "canonical-1",
    status: "Approved",
    queueState: "approved",
  });
  const update: Record<string, unknown> = {
    ...existing,
    stock: 12,
    ...buildSupplierReviewBusinessQueueProjection({ ...existing, stock: 12 } as never),
  };
  assert.equal(update.businessQueueClassesVersion, SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION);
  assert.equal(update.canonicalProductId, "canonical-1");
  assert.equal(update.decisionAuditId, "audit-1");
  assert.equal(update.decisionProductId, "canonical-1");

  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(sync, /Object\.assign\(queueData, buildSupplierReviewBusinessQueueProjection\(queueData\)\)/u);
  assert.match(sync, /suppressionPatch[\s\S]*buildSupplierReviewBusinessQueueProjection\(\{/u);
  assert.match(sync, /categoryRequirementForQueueRecord\(queueData, storeCategories\)/u);
});

test("canonical category requirements are applied by writers while lifecycle rewrites preserve repaired v4 state", () => {
  const categoryNeedsChild = baseRecord({
    productPayload: { category: "electronics", subcategory: "", stock: 10 },
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  });
  assert.equal(supplierReviewCategoryRequiresSubcategory(categoryNeedsChild as never), false);
  assert.deepEqual(
    buildSupplierReviewBusinessQueueProjection(categoryNeedsChild as never, true).businessQueueClasses,
    ["actionable", "category_decision_required", "new_products"],
  );

  const repaired = {
    ...categoryNeedsChild,
    businessQueueClasses: ["actionable", "category_decision_required", "new_products"],
    businessQueueClassesVersion: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
  };
  assert.equal(supplierReviewCategoryRequiresSubcategory(repaired as never), true);
  assert.deepEqual(
    buildSupplierReviewBusinessQueueProjection(repaired as never).businessQueueClasses,
    ["actionable", "category_decision_required", "new_products"],
  );
  const classes = buildSupplierReviewBusinessQueueProjection({
    ...repaired,
    productValidation: { readyToPublish: false, missingFields: [], errors: [] },
  } as never).businessQueueClasses as string[];
  assert.equal(classes.includes("missing_details"), false);
  assert.equal(classes.includes("needs_attention"), false);
});

test("zero stock remains held for unpublished records but live stock-only records keep their existing actionable policy", () => {
  const unpublished = baseRecord({
    stock: 0,
    productPayload: { category: "", stock: 0 },
    comparison: { comparisonStatus: "NEW_PRODUCT", matchedProductLive: false, changedFields: [] },
    supplierSnapshot: { inventoryLevel: 0, providedFields: ["stock"], supplierMetadata: { supplierStockAvailable: true } },
  });
  const unpublishedClasses = buildSupplierReviewBusinessQueueProjection(unpublished as never).businessQueueClasses as string[];
  assert.deepEqual(unpublishedClasses, ["stock_price_issues", "low_stock_hold"]);
  assert.equal(unpublishedClasses.includes("actionable"), false);

  const live = baseRecord({
    stock: 0,
    productPayload: { category: "", stock: 0 },
    comparison: { comparisonStatus: "STOCK_CHANGED", matchedProductLive: true, changedFields: ["Stock"] },
    supplierSnapshot: { inventoryLevel: 0, providedFields: ["stock"], supplierMetadata: { supplierStockAvailable: true } },
  });
  const liveClasses = buildSupplierReviewBusinessQueueProjection(live as never).businessQueueClasses as string[];
  assert.equal(liveClasses.includes("actionable"), true);
  assert.equal(liveClasses.includes("low_stock_hold"), false);
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

test("active v4 markers repair mixed legacy records but remain a no-op when compatible", () => {
  const activeV4 = {
    status: "active" as const,
    version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
    scanned: 6384,
    projected: 6384,
    lastDocumentId: null,
  };

  assert.equal(migrationModeFor(activeV4, true), "mixed-version-repair");
  assert.equal(migrationModeFor(activeV4, false), "noop");
  assert.equal(migrationModeFor(undefined, false), "initial");
});

test("mixed-version repair preserves checkpoint resume and idempotent projection writes", () => {
  const pendingV4 = {
    status: "pending" as const,
    version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
    scanned: 400,
    projected: 120,
    lastDocumentId: "review-0400",
  };
  const projection = {
    businessQueueClasses: ["actionable"],
    businessQueueClassesVersion: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
  };

  assert.equal(canResumeSupplierReviewBusinessProjectionMigration(pendingV4), true);
  assert.equal(projectionPatchRequiresWrite({
    businessQueueClasses: ["legacy"],
    businessQueueClassesVersion: 3,
  }, projection), true);
  assert.equal(projectionPatchRequiresWrite(projection, projection), false);
  assert.deepEqual(migrationCheckpointForProjectionVersion(pendingV4), {
    scanned: 400,
    projected: 120,
    lastDocumentId: "review-0400",
  });
});

test("migration fencing ignores projection-only changes but detects source and taxonomy-input changes", () => {
  const source = {
    status: "Pending",
    stock: 10,
    productPayload: { category: "electronics", subcategory: "phones" },
    businessQueueClasses: ["missing_details"],
    businessQueueClassesVersion: 3,
  };
  assert.equal(supplierReviewProjectionSourceFingerprint({
    ...source,
    businessQueueClasses: ["actionable"],
    businessQueueClassesVersion: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
  }), supplierReviewProjectionSourceFingerprint(source));
  assert.notEqual(
    supplierReviewProjectionSourceFingerprint(source),
    supplierReviewProjectionSourceFingerprint({ ...source, stock: 0 }),
  );
  assert.notEqual(
    supplierReviewProjectionSourceFingerprint(source),
    supplierReviewProjectionSourceFingerprint({
      ...source,
      productPayload: { category: "home-kitchen", subcategory: "phones" },
    }),
  );
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
  assert.match(migration, /businessQueueClassesVersion", "!=", SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION/u);
  assert.match(migration, /migrationModeFor\(\s*existing/u);
  assert.match(migration, /migrationMode[\s\S]*mixed-version-repair/u);
  assert.match(migration, /dry-run-no-metadata-writes/u);
  assert.match(migration, /category-reads-by-referenced-id/u);
  assert.match(migration, /runTransaction\(async \(transaction\)/u);
  assert.match(migration, /supplierReviewProjectionSourceFingerprint/u);
  assert.match(migration, /conflictIds/u);
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
  assert.equal(supplierReviewReadinessGroupForRecord(complete as never), "ready_to_publish");
  assert.equal(reviewRecordMatchesBusinessFilter(complete as never, "ready_to_publish"), true);
  assert.ok((buildSupplierReviewBusinessQueueProjection(complete as never).businessQueueClasses as string[]).includes("ready_for_review"));
  assert.ok((buildSupplierReviewBusinessQueueProjection(complete as never).businessQueueClasses as string[]).includes("ready_to_publish"));

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

test("readiness groups preserve primary blocker precedence without weakening approval predicates", () => {
  const categoryDecision = baseRecord({
    productValidation: { readyToPublish: false, missingFields: ["category"], errors: [{ field: "category", code: "required" }] },
  });
  assert.equal(supplierReviewReadinessGroupForRecord(categoryDecision as never), "category_decision_required");

  const categoryAndImageBlocker = baseRecord({
    productValidation: {
      readyToPublish: false,
      missingFields: ["category", "images"],
      errors: [
        { field: "category", code: "required" },
        { field: "images", code: "required" },
      ],
    },
    mediaStatus: "failed",
    mediaQueueClass: "issues",
    managedMedia: [],
  });
  assert.equal(supplierReviewReadinessGroupForRecord(categoryAndImageBlocker as never), "missing_details");
  assert.ok((buildSupplierReviewBusinessQueueProjection(categoryAndImageBlocker as never).businessQueueClasses as string[]).includes("needs_attention"));

  const stockAndDetails = baseRecord({
    productValidation: { readyToPublish: false, missingFields: ["stock", "images"], errors: [{ field: "stock", code: "required" }] },
    stock: 1,
    productPayload: { category: "category-1", stock: 1 },
  });
  assert.equal(supplierReviewReadinessGroupForRecord(stockAndDetails as never), "stock_price_issues");

  const conflict = baseRecord({
    productValidation: { readyToPublish: false, missingFields: [], errors: [{ field: "identity", code: "duplicate_product" }] },
  });
  assert.equal(supplierReviewReadinessGroupForRecord(conflict as never), "conflicts");
  assert.equal(reviewRecordMatchesBusinessFilter(conflict as never, "missing_details"), false);
});
