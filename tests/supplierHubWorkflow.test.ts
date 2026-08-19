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
  assert.doesNotMatch(supplierHub, /runLocalSupplierSync|filterSupplierComparison|commitSupplierSyncWrites/);
  assert.match(scheduledSync, /if \(!selectedComparison\) \{[\s\S]*metrics\.productsSkipped \+= 1;[\s\S]*continue;/);
});

test("visible supplier sync controls invoke the real queue synchronization pipeline", () => {
  const source = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  const scheduledSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.equal(source.includes("Placeholder Action Only"), false);
  assert.match(source, /await runManualSupplierSync\(\{ sourceIds: \[id\], mode: 'full' \}\)/);
  assert.match(source, /<SupplierManualSyncDialog/);
  assert.match(source, /onClick=\{\(\) => handleTriggerSync\(source\.id\)\}/);
  assert.match(source, /postSupplierApi\('\/api\/supplier-sync'/);
  assert.match(scheduledSync, /selectSupplierComparisonForReview/);
  assert.match(scheduledSync, /resolveSupplierProductLimit/);
  assert.match(scheduledSync, /dryRunMode/);
  assert.match(scheduledSync, /discoveredCategories/);
});

test("A2Z secrets are bound to both HTTPS and scheduled Functions", () => {
  const apiEntry = readFileSync("functions/src/index.ts", "utf8");
  const scheduledSyncWorker = readFileSync("functions/src/scheduled/supplierSyncWorker.ts", "utf8");
  const secrets = readFileSync("functions/src/config/secrets.ts", "utf8");

  assert.match(secrets, /defineSecret\("A2Z_USERNAME"\)/);
  assert.match(secrets, /defineSecret\("A2Z_PASSWORD"\)/);
  assert.match(apiEntry, /secrets:\s*API_SECRETS/);
  assert.match(secrets, /API_SECRETS\s*=\s*\[\.\.\.A2Z_SECRETS\]/);
  assert.doesNotMatch(secrets, /PAYHERE_MERCHANT_SECRET/);
  assert.match(scheduledSyncWorker, /secrets:\s*A2Z_SECRETS/);
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

test("Supplier Hub exposes only individual business approval actions while Functions own synchronization and category mapping", () => {
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  const quickCard = readFileSync("src/components/SupplierReviewQuickCard.tsx", "utf8");
  const scheduledSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.doesNotMatch(supplierHub, /Bulk Approve/);
  assert.doesNotMatch(supplierHub, /Bulk Reject/);
  assert.match(supplierHub, /supplierReviewCanQuickApprove/);
  assert.match(quickCard, /View Details/);
  assert.doesNotMatch(supplierHub, /Bulk Delete/);
  assert.match(supplierHub, /postSupplierApi\('\/api\/supplier-sync'/);
  assert.doesNotMatch(supplierHub, /runLocalSupplierSync|commitSupplierSyncWrites|resolveSupplierCategory/);
  assert.match(scheduledSync, /suggestSupplierCategory/);
  assert.match(scheduledSync, /categoryMappingRecords/);
  assert.match(scheduledSync, /matchesSupplierCategoryFilter/);
  assert.match(scheduledSync, /settings\.categoryMappings/);
  assert.match(scheduledSync, /isSupplierSourceAutoSyncDue/);
  assert.match(scheduledSync, /selectSupplierComparisonForReview/);
  assert.match(scheduledSync, /hasActiveReviewQueueItem/);
  assert.match(scheduledSync, /dryRunMode/);
});

test("Supplier Hub loads bounded sync history through the protected API and retries expired admin tokens", () => {
  const operations = readFileSync("src/components/supplier-operations/SupplierOperationsDashboard.tsx", "utf8");
  const supplierApi = readFileSync("src/services/supplierHubApi.ts", "utf8");
  assert.match(operations, /supplier-operations\/sync-history\?limit=40/);
  assert.match(operations, /setHistoryCursor\(historyResult\.nextCursor\)/);
  assert.match(supplierApi, /if \(response\.status === 401\) response = await request\(true\)/);
});

test("Supplier Hub production settings and catalog limits are enforced by the Functions sync path", () => {
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  const scheduledSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  const supplierApi = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.doesNotMatch(supplierHub, /supplierSettings\.websiteSyncEnabled === false|limitSupplierProducts|commitSupplierSyncWrites/);
  assert.match(supplierHub, /postSupplierApi\('\/api\/supplier-sync'/);
  assert.doesNotMatch(scheduledSync, /settings\.websiteSyncEnabled === false/);
  assert.doesNotMatch(scheduledSync, /trigger === "manual" \? \[\] : settings\.enabledSupplierIds/);
  assert.match(scheduledSync, /resolveSupplierProductLimit/);
  assert.match(scheduledSync, /normalizeSupplierCatalogPageSize\(sourcePageSize\)/);
  assert.match(scheduledSync, /runSupplierCatalogTraversal/);
  assert.match(scheduledSync, /for \(const product of productsToProcess\)/);
  assert.match(supplierApi, /requestedProductLimit/);
  assert.match(scheduledSync, /existingQueueIds\.has\(queueItemId\)/);
  assert.match(scheduledSync, /calculateSupplierInitialPricing/);
  assert.equal(supplierHub.includes("{ id: 'electronics', name: 'Electronics' }"), false);
});

test("A2Z keeps active zero-stock products so stock changes can reach review", () => {
  const functionConnector = readFileSync("functions/src/api/suppliers/a2z/A2ZConnectorService.ts", "utf8");
  assert.equal(functionConnector.includes("parsed.inventoryLevel > 0"), false);
  assert.match(functionConnector, /parsed\.sku && parsed\.title && isLiveStatus/);
});
