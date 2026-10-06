import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierReviewBusinessQueueProjection,
  reviewRecordMatchesBusinessFilter,
} from "../functions/src/scheduled/supplierReviewQueue";

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
