import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  calculateOperationsPerformance,
  calculateSupplierHealthScore,
  generateSupplierOperationsAlerts,
  toOperationsIso,
} from "../functions/src/api/suppliers/supplierOperations";

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("operations dashboard calculates supplier health from factual sync metadata", () => {
  const healthy = calculateSupplierHealthScore({
    enabled: true,
    connectionStatus: "connected",
    syncHealth: { successRate: 98, lastSuccessfulSyncAt: "2026-07-24T01:00:00.000Z" },
  }, Date.parse("2026-07-24T02:00:00.000Z"));
  const failed = calculateSupplierHealthScore({
    enabled: true,
    connectionStatus: "Failed",
    lastFailedSyncAt: "2026-07-24T01:30:00.000Z",
    lastSuccessfulSyncAt: "2026-07-23T01:00:00.000Z",
    syncHealth: { successRate: 60 },
  }, Date.parse("2026-07-24T02:00:00.000Z"));
  assert.equal(healthy, 98);
  assert.equal(failed, 5);
  assert.equal(calculateSupplierHealthScore({ enabled: false }), 0);
});

test("operations dashboard generates actionable supplier, queue, media, and conflict alerts", () => {
  const alerts = generateSupplierOperationsAlerts({
    suppliers: [{
      id: "supplier-a",
      enabled: true,
      name: "Supplier A",
      connectionStatus: "Failed",
      lastFailedSyncAt: "2026-07-24T01:30:00.000Z",
      syncHealth: { successRate: 10 },
    }],
    queueCounts: { review_pending: 120, retryable_failure: 8, dead_letter: 3, conflict: 2 },
    mediaFailures: 4,
    storageFailures: 1,
    nowIso: "2026-07-24T02:00:00.000Z",
  });
  assert.deepEqual(new Set(alerts.map((alert) => alert.type)), new Set([
    "supplier_offline",
    "sync_failure",
    "queue_backlog",
    "repeated_retries",
    "approval_conflicts",
    "media_failures",
    "storage_failures",
  ]));
});

test("operations performance calculations do not fabricate unavailable values", () => {
  assert.deepEqual(calculateOperationsPerformance({
    syncDurations: [1_000, 3_000],
    approvalDurations: [2_000, 4_000],
    mediaDurations: [],
    approvedCount: 12,
    windowHours: 6,
  }), {
    queueThroughputPerHour: 2,
    averageSyncDurationMs: 2_000,
    averageApprovalDurationMs: 3_000,
    averageMediaProcessingDurationMs: null,
  });
  assert.equal(toOperationsIso("not-a-date"), null);
});

test("operations APIs are admin protected and preserve existing Supplier Hub routes", () => {
  const routes = projectFile("functions/src/api/routes/supplier.ts");
  for (const route of [
    "/api/supplier-operations/summary",
    "/api/supplier-operations/queue",
    "/api/supplier-operations/sync-history",
    "/api/supplier-operations/audit",
  ]) {
    assert.match(routes, new RegExp(`${route.replaceAll("/", "\\/")}[^\\n]+requireSupplierHubAdmin`));
  }
  assert.match(routes, /app\.post\("\/api\/supplier-sync", requireSupplierHubAdmin/);
  assert.match(routes, /app\.post\("\/api\/supplier-review-queue\/:queueItemId\/approve", requireSupplierHubAdmin/);
});

test("operations dashboard exposes monitoring, recovery, pagination, and export controls", () => {
  const component = projectFile("src/components/supplier-operations/SupplierOperationsDashboard.tsx");
  assert.match(component, /Auto-refreshes every 30 seconds/);
  assert.match(component, /Supplier health/);
  assert.match(component, /Queue monitoring/);
  assert.match(component, /Bulk retry/);
  assert.match(component, /Bulk reopen/);
  assert.match(component, /Bulk resolve conflicts/);
  assert.match(component, /Load more/);
  assert.match(component, /Error center/);
  assert.match(component, />Ignore</);
  assert.match(component, />Resolved</);
  assert.match(component, /Media monitoring/);
  assert.match(component, /Audit center/);
  assert.match(component, /downloadCsv/);
});

test("error dispositions and unified audit history remain server-authoritative", () => {
  const operations = projectFile("functions/src/api/suppliers/supplierOperations.ts");
  const routes = projectFile("functions/src/api/routes/supplier.ts");
  const rules = projectFile("firestore.rules");
  for (const collection of [
    "supplier_approval_audit",
    "supplier_mapping_audit",
    "supplier_media_audit",
    "supplier_sync_history",
    "supplier_operations_audit",
  ]) assert.match(operations, new RegExp(collection));
  assert.match(routes, /supplier-operations\/errors\/:queueItemId\/action/);
  assert.match(rules, /match \/supplier_operation_error_states\/\{docId\}[\s\S]*?allow create, update, delete: if false/);
  assert.match(rules, /match \/supplier_operations_audit\/\{docId\}[\s\S]*?allow create, update, delete: if false/);
});

test("sync history records imported, updated, and deletion-reconciliation metrics", () => {
  const sync = projectFile("functions/src/scheduled/supplierSync.ts");
  assert.match(sync, /productsImported: metrics\.productsImported/);
  assert.match(sync, /productsUpdated: metrics\.productsUpdated/);
  assert.match(sync, /productsDeleted: metrics\.productsDeleted/);
  assert.match(sync, /metrics\.productsDeleted \+= reconciliation\.queued/);
});

test("operations queue queries are stable, paginated, and index-backed", () => {
  const service = projectFile("functions/src/api/suppliers/supplierOperations.ts");
  const indexes = JSON.parse(projectFile("firestore.indexes.json")) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }>;
  };
  assert.match(service, /orderBy\("queueCreatedAt", "desc"\)/);
  assert.match(service, /startAfter\(cursor\)/);
  assert.match(service, /\.limit\(scanLimit\)/);
  assert.ok(indexes.indexes.some((index) => index.collectionGroup === "supplier_review_queue"
    && index.fields.some((field) => field.fieldPath === "queueState")
    && index.fields.some((field) => field.fieldPath === "queueCreatedAt" && field.order === "DESCENDING")));
});

test("Sprint 1-6 Supplier Hub contracts remain wired", () => {
  const routes = projectFile("functions/src/api/routes/supplier.ts");
  const sync = projectFile("functions/src/scheduled/supplierSync.ts");
  const reviewQueue = projectFile("functions/src/scheduled/supplierReviewQueue.ts");
  const approval = projectFile("functions/src/api/suppliers/supplierApproval.ts");
  assert.match(routes, /\/api\/supplier-sources/);
  assert.match(sync, /runSupplierCatalogTraversal/);
  assert.match(reviewQueue, /acquireSupplierManagedMedia/);
  assert.match(approval, /approvalBaseline/);
  assert.match(approval, /managedMedia/);
});
