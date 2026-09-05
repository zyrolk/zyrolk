import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierReviewCleanupPreview,
  executeSupplierReviewCleanup,
  SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
} from "../functions/src/api/suppliers/supplierReviewCleanup";

const active = (
  id: string,
  sourceId: string,
  comparisonStatus: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  version: `version-${id}`,
  data: {
    status: "Pending",
    queueState: "review_pending",
    sourceId,
    supplierCode: id.toUpperCase(),
    supplierOfferPendingRevision: id.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
    comparison: { comparisonStatus, changedFields: comparisonStatus === "PRICE_CHANGED" ? ["price"] : [] },
    productPayload: { name: `Product ${id}` },
    ...overrides,
  },
});

test("pre-launch cleanup preview targets only active non-terminal review observations", () => {
  const records = [
    active("a", "a2z", "NEW_PRODUCT"),
    active("b", "dropex", "PRICE_CHANGED"),
    active("c", "a2z", "NEW_PRODUCT", { productValidation: { readyToPublish: false, missingFields: ["category"] } }),
    active("d", "dropex", "PRICE_CHANGED", { status: "CONFLICT", queueState: "conflict" }),
    active("e", "a2z", "SUPPLIER_OFFER_REMOVED"),
    active("f", "a2z", "NEW_PRODUCT", { status: "Approved", queueState: "approved", decisionAction: "approved" }),
    active("1", "a2z", "NEW_PRODUCT", { status: "Rejected", queueState: "rejected", decisionAction: "rejected" }),
    active("2", "dropex", "NEW_PRODUCT", { status: "Rejected", queueState: "suppressed", decisionAction: "deleted" }),
    active("3", "dropex", "NEW_PRODUCT", { status: "suppressed", queueState: "review_pending" }),
    active("4", "a2z", "NEW_PRODUCT", { status: "Failed", queueState: "dead_letter" }),
  ];

  const preview = buildSupplierReviewCleanupPreview(records);

  assert.equal(preview.totalScanned, 10);
  assert.equal(preview.totalEligibleActiveItems, 4);
  assert.deepEqual(preview.countsBySource, { a2z: 2, dropex: 2 });
  assert.equal(preview.countsByActiveView.new_products, 2);
  assert.equal(preview.countsByActiveView.product_updates, 1);
  assert.equal(preview.countsByActiveView.needs_attention, 1);
  assert.equal(preview.countsByActiveView.conflicts, 1);
  assert.equal(preview.countsByActiveView.removed_products, 0);
  assert.equal(preview.excludedApprovedLive, 1);
  assert.equal(preview.excludedTerminal, 3);
  assert.equal(preview.excludedSupplierRemovals, 1);
  assert.equal(preview.excludedInactiveOrUnsupported, 1);
  assert.deepEqual(preview.eligibleItems.map((item) => item.queueItemId), ["a", "b", "c", "d"]);
});

test("confirmed cleanup uses existing removal decisions, is bounded, and is idempotent", async () => {
  let records = Array.from({ length: 30 }, (_, index) => active(
    `item-${String(index).padStart(2, "0")}`,
    index % 2 === 0 ? "a2z" : "dropex",
    index % 2 === 0 ? "NEW_PRODUCT" : "PRICE_CHANGED",
  ));
  const preview = async () => buildSupplierReviewCleanupPreview(records);
  const firstPreview = await preview();
  const calls: Array<Record<string, unknown>> = [];
  const dismiss = async (
    _db: unknown,
    queueItemId: unknown,
    action: unknown,
    _reviewer: unknown,
    options: Record<string, unknown>,
  ) => {
    calls.push({ queueItemId, action, ...options });
    records = records.map((record) => record.id === queueItemId
      ? {
        ...record,
        version: `${record.version}-dismissed`,
        data: { ...record.data, status: "Rejected", queueState: "suppressed", decisionAction: "deleted" },
      }
      : record);
    return { success: true, queueItemId, action: "deleted", status: "deleted" } as const;
  };

  const result = await executeSupplierReviewCleanup(
    {} as never,
    {
      confirmation: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
      preconditionToken: firstPreview.preconditionToken,
      expectedEligibleCount: firstPreview.totalEligibleActiveItems,
      batchLimit: 25,
    },
    { uid: "admin-1", email: "admin@zyro.lk" },
    { preview: preview as never, dismiss: dismiss as never },
  );

  assert.equal(result.processed, 25);
  assert.equal(result.dismissed, 25);
  assert.equal(result.failed, 0);
  assert.equal(result.remainingPreview.totalEligibleActiveItems, 5);
  assert.equal(calls.every((call) => call.action === "deleted"), true);
  assert.equal(calls.every((call) => call.deletionReason === "review_removed_by_admin: pre-launch Product Review cleanup"), true);

  const second = await executeSupplierReviewCleanup(
    {} as never,
    {
      confirmation: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
      preconditionToken: result.remainingPreview.preconditionToken,
      expectedEligibleCount: result.remainingPreview.totalEligibleActiveItems,
    },
    { uid: "admin-1", email: "admin@zyro.lk" },
    { preview: preview as never, dismiss: dismiss as never },
  );
  assert.equal(second.processed, 5);
  assert.equal(second.remainingPreview.totalEligibleActiveItems, 0);
  assert.equal(calls.length, 30);

  const idempotent = await executeSupplierReviewCleanup(
    {} as never,
    {
      confirmation: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
      preconditionToken: second.remainingPreview.preconditionToken,
      expectedEligibleCount: 0,
    },
    { uid: "admin-1", email: "admin@zyro.lk" },
    { preview: preview as never, dismiss: dismiss as never },
  );
  assert.equal(idempotent.processed, 0);
  assert.equal(calls.length, 30);
});

test("cleanup requires a fresh preview and an authorized API route", async () => {
  const preview = buildSupplierReviewCleanupPreview([active("a", "a2z", "NEW_PRODUCT")]);
  let decisionCalls = 0;
  await assert.rejects(executeSupplierReviewCleanup(
    {} as never,
    {
      confirmation: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
      preconditionToken: "f".repeat(64),
      expectedEligibleCount: preview.totalEligibleActiveItems,
    },
    { uid: "admin-1", email: "admin@zyro.lk" },
    {
      preview: (async () => preview) as never,
      dismiss: (async () => { decisionCalls += 1; }) as never,
    },
  ), /changed after preview/i);
  assert.equal(decisionCalls, 0);

  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.match(routes, /app\.get\("\/api\/supplier-review-queue\/maintenance\/prelaunch-cleanup", requireSupplierHubAdmin/);
  assert.match(routes, /app\.post\("\/api\/supplier-review-queue\/maintenance\/prelaunch-cleanup", requireSupplierHubAdmin/);
});

test("cleanup does not fabricate supplier catalogue removals", () => {
  const preview = buildSupplierReviewCleanupPreview([
    active("a", "a2z", "NEW_PRODUCT"),
    active("b", "dropex", "PRICE_CHANGED"),
  ]);
  assert.equal(preview.countsByActiveView.removed_products, 0);
});
