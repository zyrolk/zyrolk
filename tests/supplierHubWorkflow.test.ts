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
  assert.match(supplierHub, /if \(!enabledComparison\) continue/);
  assert.match(scheduledSync, /if \(!comparison\) \{[\s\S]*metrics\.productsSkipped \+= 1;[\s\S]*continue;/);
});

test("visible supplier sync controls invoke the real queue synchronization pipeline", () => {
  const source = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.equal(source.includes("Placeholder Action Only"), false);
  assert.match(source, /await handleSyncSupplier\(\[id\]\)/);
  assert.match(source, /onClick=\{\(\) => handleSyncSupplier\(\)\}/);
  assert.match(source, /filterSupplierComparison/);
  assert.match(source, /resolveSupplierProductLimit/);
  assert.match(source, /dryRunMode/);
  assert.match(source, /discoveredCategories/);
});

test("A2Z secrets are bound to both HTTPS and scheduled Functions", () => {
  const apiEntry = readFileSync("functions/src/index.ts", "utf8");
  const scheduledSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  const secrets = readFileSync("functions/src/config/secrets.ts", "utf8");

  assert.match(secrets, /defineSecret\("A2Z_USERNAME"\)/);
  assert.match(secrets, /defineSecret\("A2Z_PASSWORD"\)/);
  assert.match(apiEntry, /secrets:\s*API_SECRETS/);
  assert.match(secrets, /API_SECRETS\s*=\s*\[\.\.\.A2Z_SECRETS\]/);
  assert.doesNotMatch(secrets, /PAYHERE_MERCHANT_SECRET/);
  assert.match(scheduledSync, /secrets:\s*A2Z_SECRETS/);
});

test("supplier test and fetch routes share the connector registry", () => {
  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  const fetchService = readFileSync("functions/src/api/suppliers/fetchSupplierProducts.ts", "utf8");
  assert.match(routes, /SupplierRegistry\.createConnectorForTarget/);
  assert.match(fetchService, /SupplierRegistry\.createConnectorForTarget/);
});

test("approval writes products, persists audit, and cleans queues", () => {
  const supplierSnapshot = {
    supplierName: "A2Z",
    supplierSku: "A2Z-100",
    wholesalePrice: 700,
  };
  const plan = buildSupplierQueueDecisionPlan(
    {
      id: "review-1",
      sourceId: "a2z",
      batchId: "batch-1",
      productPayload,
      supplierSnapshot,
    },
    "approved",
    { uid: "admin-1", email: "admin@example.com" },
    "SERVER_TIMESTAMP",
    "audit-1",
  );

  assert.equal(plan.sets.some((operation) => operation.collection === "products" && operation.id === "approved-product"), true);
  assert.equal(plan.sets.some((operation) => operation.collection === "supplier_approval_audit" && operation.id === "audit-1"), true);
  const audit = plan.sets.find((operation) => operation.collection === "supplier_approval_audit");
  assert.deepEqual(audit?.data.supplierSnapshot, supplierSnapshot);
  assert.deepEqual(audit?.data.publishedProductSnapshot, productPayload);
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

test("bulk delete decisions preserve audit and never write products", () => {
  const plan = buildSupplierQueueDecisionPlan(
    {
      id: "review-3",
      sourceId: "a2z",
      batchId: "batch-3",
      deletionReason: "Bulk deleted by admin.",
    },
    "deleted",
    { uid: "admin-1", email: "admin@example.com" },
    "SERVER_TIMESTAMP",
    "audit-3",
  );

  assert.equal(plan.sets.some((operation) => operation.collection === "products"), false);
  const audit = plan.sets.find((operation) => operation.collection === "supplier_approval_audit");
  assert.equal(audit?.data.action, "deleted");
  assert.equal(audit?.data.deletionReason, "Bulk deleted by admin.");
  assert.equal(plan.deletes.length, 3);
});

test("Supplier Hub exposes audited bulk actions and both sync paths resolve persistent category mappings", () => {
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  const scheduledSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(supplierHub, /Bulk Approve/);
  assert.match(supplierHub, /Bulk Reject/);
  assert.match(supplierHub, /Bulk Delete/);
  assert.match(supplierHub, /resolveSupplierCategory/);
  assert.match(supplierHub, /matchesSupplierCategoryFilter/);
  assert.match(scheduledSync, /suggestSupplierCategory/);
  assert.match(scheduledSync, /categoryMappingRecords/);
  assert.match(scheduledSync, /matchesSupplierCategoryFilter/);
  assert.match(scheduledSync, /settings\.categoryMappings/);
  assert.match(scheduledSync, /isSupplierSourceAutoSyncDue/);
  assert.match(scheduledSync, /filterSupplierComparison/);
  assert.match(scheduledSync, /dryRunMode/);
});

test("Supplier Hub limits sync history queries and retries expired admin tokens", () => {
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.match(supplierHub, /limit\(SYNC_HISTORY_LIMIT\)/);
  assert.match(supplierHub, /orderBy\("createdAt", "desc"\)/);
  assert.match(supplierHub, /if \(response\.status === 401\) response = await request\(true\)/);
});

test("Supplier Hub production settings are enforced in both active sync paths", () => {
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  const scheduledSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  const supplierApi = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.match(supplierHub, /supplierSettings\.websiteSyncEnabled === false/);
  assert.match(scheduledSync, /settings\.websiteSyncEnabled === false/);
  assert.match(scheduledSync, /enabledSupplierIdsConfigured === true/);
  assert.match(supplierHub, /resolveSupplierProductLimit/);
  assert.match(scheduledSync, /resolveSupplierProductLimit/);
  assert.match(supplierHub, /limitSupplierProducts<RawA2ZProduct>\(fetched as RawA2ZProduct\[\], limitNum\)/);
  assert.match(scheduledSync, /normalizeSupplierCatalogPageSize\(sourcePageSize\)/);
  assert.match(scheduledSync, /runSupplierCatalogTraversal/);
  assert.match(supplierHub, /productLimit: limitNum/);
  assert.match(supplierHub, /for \(const prod of slicedProducts\)/);
  assert.match(scheduledSync, /for \(const product of productsToProcess\)/);
  assert.match(supplierHub, /\[SupplierLimitTrace\] queue-writer-input/);
  assert.match(supplierApi, /requestedProductLimit/);
  assert.match(supplierHub, /existingQueueIds\.has\(queueItemId\)/);
  assert.match(scheduledSync, /existingQueueIds\.has\(queueItemId\)/);
  assert.match(supplierHub, /calculateSupplierInitialPricing/);
  assert.match(scheduledSync, /calculateSupplierInitialPricing/);
  assert.equal(supplierHub.includes("{ id: 'electronics', name: 'Electronics' }"), false);
});

test("A2Z keeps active zero-stock products so stock changes can reach review", () => {
  const localConnector = readFileSync("src/services/connectors/a2z-website/A2ZConnectorService.ts", "utf8");
  const functionConnector = readFileSync("functions/src/api/suppliers/a2z/A2ZConnectorService.ts", "utf8");
  for (const connector of [localConnector, functionConnector]) {
    assert.equal(connector.includes("parsed.inventoryLevel > 0"), false);
    assert.match(connector, /parsed\.sku && parsed\.title && isLiveStatus/);
  }
});
