import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ProductParser } from "../functions/src/api/suppliers/a2z/ProductParser";
import { buildSupplierProductOffer } from "../functions/src/api/suppliers/supplierOfferEngine";
import { listSupplierQueuePage } from "../functions/src/scheduled/supplierReviewQueue";
import { buildSupplierDuplicateConflictReviewItem } from "../functions/src/scheduled/supplierSync";

const detectedAt = "2026-07-29T08:00:00.000Z";
const queueItemId = "a2z-traders-duplicate-1";
const product = ProductParser.parseJsonPayload({
  id: "duplicate-row-2",
  sku: "DUPLICATE-1",
  title: "Duplicate Phone",
  description: "Supplier duplicate",
  price: 1_500,
  costPrice: 1_000,
  stock: 4,
  images: ["https://supplier.example/duplicate-phone.jpg"],
});
const offer = buildSupplierProductOffer({
  sourceId: "a2z-traders",
  supplierId: "a2z-traders",
  supplierProductId: "duplicate-row-2",
  sku: product.sku,
  productId: "duplicate-phone",
  price: 1_500,
  cost: 1_000,
  stock: 4,
  availability: "in_stock",
  priority: 100,
  health: { availability: "available" },
  lastSyncAt: detectedAt,
  supplierSnapshot: product,
  timestamp: detectedAt,
});
const approvalBaseline = {
  productId: "duplicate-phone",
  exists: true,
  version: "baseline-1",
  capturedAt: detectedAt,
};
const existingReview = {
  id: queueItemId,
  status: "Pending",
  queueState: "review_pending",
  supplierCode: product.sku,
  productName: "Canonical Phone",
  productPayload: {
    id: "duplicate-phone",
    name: "Canonical Phone",
    description: "Approved description",
    price: 1_500,
    stock: 4,
    imageUrl: "https://supplier.example/canonical-phone.jpg",
  },
  approvalBaseline,
  productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  comparisonStatus: "NEW_PRODUCT",
  comparison: { comparisonStatus: "NEW_PRODUCT", changedFields: [], fieldChanges: [] },
  createdAt: detectedAt,
};

const buildConflictReview = () => buildSupplierDuplicateConflictReviewItem({
  queueItemId,
  existingQueueItem: existingReview,
  currentProduct: existingReview.productPayload,
  source: { id: "a2z-traders", supplierName: "A2Z Traders", connectorType: "a2z" },
  product,
  offer,
  winner: {
    supplierId: "a2z-traders",
    sourceId: "a2z-traders",
    priority: 100,
    queueItemId,
    productId: "duplicate-phone",
    offerId: "winning-offer",
  },
  batchId: "manual-sync-1",
  detectedAt,
});

test("same-supplier duplicate projects one deterministic conflict into Product Review", async () => {
  const conflictReview = buildConflictReview();
  assert.equal(conflictReview.id, queueItemId);
  assert.equal(conflictReview.data.status, "CONFLICT");
  assert.equal(conflictReview.data.queueState, "conflict");
  assert.equal(conflictReview.data.supplierOfferId, offer.id);
  assert.equal(conflictReview.data.approvalBaseline, approvalBaseline);
  assert.deepEqual(conflictReview.data.productPayload, existingReview.productPayload);

  const document = { id: conflictReview.id, data: () => conflictReview.data };
  const query = {
    where(field: string, operator: string, value: unknown) {
      assert.deepEqual([field, operator, value], ["status", "==", "CONFLICT"]);
      return query;
    },
    orderBy() { return query; },
    limit() { return query; },
    async get() { return { docs: [document], size: 1 }; },
  };
  const db = {
    collection(name: string) {
      assert.equal(name, "supplier_review_queue");
      return query;
    },
  };
  const page = await listSupplierQueuePage(db as never, { view: "review", state: "conflict", limit: 50 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, queueItemId);
});

test("duplicate conflict requires explicit manual review and is never auto-approved", () => {
  const conflictReview = buildConflictReview();
  const validation = conflictReview.data.productValidation as Record<string, unknown>;
  const errors = validation.errors as Array<Record<string, unknown>>;
  assert.equal(validation.readyToPublish, false);
  assert.equal(errors.some((error) => error.code === "duplicate_supplier_product"), true);
  assert.deepEqual(conflictReview.data.approvalConflict, {
    reason: "duplicate_supplier_product",
    changedFields: ["Duplicate supplier product"],
  });
});

test("duplicate detection keeps its conflict record and reuses the existing review write", () => {
  const source = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(source, /collection: "supplier_product_conflicts", id: record\.id, data: record\.data/u);
  assert.match(source, /write\.collection === "supplier_review_queue" && write\.id === queueItemId/u);
  assert.match(source, /if \(queuedReviewWrite\) queuedReviewWrite\.data = conflictReview\.data/u);
  assert.match(source, /if \(!queuedReviewWrite && !activeReviewQueueDoc\) metrics\.productsQueued\+\+/u);
  assert.doesNotMatch(source, /queuedWrites\.push\(\{\s*collection: "products"/u);
  assert.equal(buildConflictReview().id, buildConflictReview().id);
});

test("non-conflict imports retain the existing comparison and review path", () => {
  const source = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(source, /if \(duplicateFromSameSource\) \{[\s\S]*buildSupplierDuplicateConflictReviewItem\(\{[\s\S]*continue;\s*\}/u);
  assert.match(source, /const selectedComparison = selectSupplierComparisonForReview\(/u);
  assert.match(source, /const comparison = activeReviewQueueData[\s\S]*accumulateSupplierProductComparison/u);
  assert.match(source, /collection: "supplier_review_queue",[\s\S]*id: queueItemId,[\s\S]*data: queueData/u);
});
