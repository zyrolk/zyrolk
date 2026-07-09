import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildSupplierQueueDecisionPlan } from "../src/services/supplierQueueDecisionPlan";

const productPayload = {
  id: "approved-product",
  name: "Approved Product",
  description: "Ready for approval",
  price: 1000,
  imageUrl: "https://example.com/image.jpg",
  category: "electronics",
  rating: 5,
  reviewsCount: 0,
  stock: 5,
  specs: {},
};

test("supplier sync regression: sync code does not queue direct writes to products", () => {
  const root = process.cwd();
  const supplierHub = readFileSync(join(root, "src/components/SupplierHubFiveStars.tsx"), "utf8");
  const scheduledSync = readFileSync(join(root, "functions/src/scheduled/supplierSync.ts"), "utf8");

  assert.equal(/batch\.set\(doc\(db,\s*["']products["']/.test(supplierHub), false);
  assert.equal(/queuedWrites\.push\(\{\s*collection:\s*["']products["']/.test(scheduledSync), false);
});

test("approval writes products, persists audit, and cleans queues", () => {
  const plan = buildSupplierQueueDecisionPlan(
    {
      id: "review-1",
      sourceId: "a2z",
      batchId: "batch-1",
      productPayload,
    },
    "approved",
    { uid: "admin-1", email: "admin@example.com" },
    "SERVER_TIMESTAMP",
    "audit-1",
  );

  assert.equal(plan.sets.some((operation) => operation.collection === "products" && operation.id === "approved-product"), true);
  assert.equal(plan.sets.some((operation) => operation.collection === "supplier_approval_audit" && operation.id === "audit-1"), true);
  assert.deepEqual(plan.deletes.map((operation) => operation.collection).sort(), [
    "supplier_import_queue",
    "supplier_pending_changes",
    "supplier_review_queue",
  ]);
});

test("rejection never writes products but still creates audit and queue cleanup", () => {
  const plan = buildSupplierQueueDecisionPlan(
    {
      id: "change-review-2",
      sourceId: "a2z",
      batchId: "batch-2",
      rejectionReason: "Bad data",
    },
    "rejected",
    { uid: "admin-1", email: "admin@example.com" },
    "SERVER_TIMESTAMP",
    "audit-2",
  );

  assert.equal(plan.sets.some((operation) => operation.collection === "products"), false);
  const audit = plan.sets.find((operation) => operation.collection === "supplier_approval_audit");
  assert.equal(audit?.data.rejectionReason, "Bad data");
  assert.deepEqual(plan.deletes, [
    { collection: "supplier_review_queue", id: "review-2" },
    { collection: "supplier_pending_changes", id: "change-review-2" },
    { collection: "supplier_import_queue", id: "review-2" },
  ]);
});
