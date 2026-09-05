import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideSupplierQueueItem } from "../functions/src/api/suppliers/supplierApproval";
import {
  buildSupplierReviewCleanupPreview,
  dismissOrphanedDeadLetterObservationForPrelaunchCleanup,
  evaluateSupplierReviewCleanupEligibility,
  executeSupplierReviewCleanup,
  PRELAUNCH_ORPHANED_DEAD_LETTER_CLEANUP_REASON,
  SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
} from "../functions/src/api/suppliers/supplierReviewCleanup";
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  SupplierProductOffer,
} from "../functions/src/api/suppliers/supplierOfferEngine";
import { reviewRecordIsTerminalDecision } from "../functions/src/scheduled/supplierReviewQueue";

type StoredDocument = Record<string, unknown>;

const revisionFor = (id: string): string => (
  id.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a")
);

const buildOffer = (
  id: string,
  sourceId: string,
  options: { pending?: boolean; reviewStatus?: SupplierProductOffer["reviewStatus"] } = {},
): SupplierProductOffer => {
  const base = buildSupplierProductOffer({
    sourceId,
    supplierId: `${sourceId}-supplier`,
    supplierProductId: `${id}-product`,
    sku: id.toUpperCase(),
    barcode: "",
    productId: null,
    price: 100,
    cost: 70,
    stock: 5,
    availability: "in_stock",
    priority: 100,
    health: {},
    lastSyncAt: "2026-09-05T00:00:00.000Z",
    reviewStatus: options.reviewStatus || "review_pending",
    catalogPayload: { name: `Product ${id}` },
    supplierSnapshot: { sourceId, supplierProductId: `${id}-product`, supplierSku: id.toUpperCase() },
    timestamp: "2026-09-05T00:00:00.000Z",
  });
  if (!options.pending) {
    return { ...base, pendingObservation: null };
  }
  return {
    ...base,
    pendingObservation: buildSupplierOfferPendingObservation({
      offer: base,
      kind: "catalog_upsert",
      reviewQueueItemId: id,
      observedAt: "2026-09-05T00:00:00.000Z",
      traversalId: "traversal-1",
    }),
  };
};

const active = (
  id: string,
  sourceId: string,
  comparisonStatus: string,
  overrides: Record<string, unknown> = {},
  offer: SupplierProductOffer | null | undefined = buildOffer(id, sourceId, { pending: true }),
) => {
  const resolvedOffer = offer === undefined ? buildOffer(id, sourceId, { pending: true }) : offer;
  const pendingRevision = resolvedOffer?.pendingObservation?.revision || revisionFor(id);
  return {
    id,
    version: `version-${id}`,
    offer: resolvedOffer,
    data: {
      status: "Pending",
      queueState: "review_pending",
      sourceId,
      supplierCode: id.toUpperCase(),
      supplierOfferId: resolvedOffer?.id,
      supplierOfferPendingRevision: pendingRevision,
      comparison: { comparisonStatus, changedFields: comparisonStatus === "PRICE_CHANGED" ? ["price"] : [] },
      productPayload: { name: `Product ${id}` },
      supplierSnapshot: {
        sourceId,
        supplierProductId: `${id}-product`,
        supplierSku: id.toUpperCase(),
      },
      ...overrides,
    },
  };
};

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  const writes: Array<{ operation: string; key: string; data?: StoredDocument }> = [];
  let generatedId = 0;

  const documentReference = (collectionName: string, id: string) => {
    const reference = {
      kind: "document" as const,
      collectionName,
      id,
      key: `${collectionName}/${id}`,
      get: async () => documentSnapshot(reference),
    };
    return reference;
  };
  const documentSnapshot = (reference: ReturnType<typeof documentReference>) => {
    const data = documents.get(reference.key);
    return { exists: data !== undefined, id: reference.id, ref: reference, data: () => data };
  };
  const transaction = {
    get: async (reference: ReturnType<typeof documentReference>) => documentSnapshot(reference),
    set: (reference: ReturnType<typeof documentReference>, data: StoredDocument, options?: { merge?: boolean }) => {
      writes.push({ operation: "set", key: reference.key, data });
      documents.set(reference.key, options?.merge ? { ...(documents.get(reference.key) || {}), ...data } : data);
    },
    create: (reference: ReturnType<typeof documentReference>, data: StoredDocument) => {
      writes.push({ operation: "create", key: reference.key, data });
      documents.set(reference.key, data);
    },
    delete: (reference: ReturnType<typeof documentReference>) => {
      writes.push({ operation: "delete", key: reference.key });
      documents.delete(reference.key);
    },
  };
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => documentReference(collectionName, id || `generated-${++generatedId}`),
    }),
    runTransaction: async <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
    getAll: async (...references: Array<ReturnType<typeof documentReference>>) => references.map((reference) => documentSnapshot(reference)),
  };
  return { db, documents, writes };
};

const orphanedFixture = () => {
  const offer = buildOffer("orphan-1", "a2z-dropshipping", { pending: false });
  const revision = revisionFor("orphan-1");
  return createFakeFirestore({
    "supplier_review_queue/orphan-1": {
      status: "Pending",
      queueState: "dead_letter",
      sourceId: "a2z-dropshipping",
      supplierCode: "P00027",
      supplierOfferId: offer.id,
      supplierOfferPendingRevision: revision,
      comparison: { comparisonStatus: "NEW_PRODUCT", changedFields: [] },
      productValidation: { readyToPublish: false, missingFields: ["category"] },
      productName: "Seat Back Support",
      productPayload: { id: "product-1", name: "Seat Back Support" },
      supplierSnapshot: {
        sourceId: "a2z-dropshipping",
        supplierProductId: "orphan-1-product",
        supplierSku: "P00027",
      },
    },
    [`supplier_product_offers/${offer.id}`]: { ...offer },
  });
};

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
    active("4", "a2z", "NEW_PRODUCT", { status: "Failed", queueState: "dead_letter" }, null),
  ];

  const preview = buildSupplierReviewCleanupPreview(records);

  assert.equal(preview.totalScanned, 10);
  assert.equal(preview.totalEligibleActiveItems, 4);
  assert.equal(preview.eligibleNormalActiveItems, 4);
  assert.equal(preview.eligibleOrphanedDeadLetterItems, 0);
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
  assert.equal(preview.eligibleItems.every((item) => item.cleanupKind === "normal_active"), true);
});

test("preview and execution agree for orphaned dead-letter rows", () => {
  const offer = buildOffer("orphan-1", "a2z-dropshipping", { pending: false });
  const record = active("orphan-1", "a2z-dropshipping", "NEW_PRODUCT", {
    status: "Pending",
    queueState: "dead_letter",
    supplierOfferPendingRevision: revisionFor("orphan-1"),
  }, offer);
  const preview = buildSupplierReviewCleanupPreview([record]);
  assert.equal(preview.totalEligibleActiveItems, 1);
  assert.equal(preview.eligibleOrphanedDeadLetterItems, 1);
  assert.equal(preview.eligibleItems[0]?.cleanupKind, "orphaned_dead_letter");
  assert.equal(
    evaluateSupplierReviewCleanupEligibility("orphan-1", record.data, offer).kind,
    preview.eligibleItems[0]?.cleanupKind,
  );
});

test("orphaned dead_letter cleanup succeeds without mutating supplier offer state", async () => {
  const { db, documents, writes } = orphanedFixture();
  const offer = buildOffer("orphan-1", "a2z-dropshipping", { pending: false });
  const offerBefore = { ...documents.get(`supplier_product_offers/${offer.id}`)! };
  const revision = revisionFor("orphan-1");

  const result = await dismissOrphanedDeadLetterObservationForPrelaunchCleanup(
    db as never,
    "orphan-1",
    { uid: "admin-1", email: "admin@zyro.lk" },
    { expectedPendingRevision: revision },
  );

  assert.equal(result.success, true);
  assert.deepEqual(documents.get(`supplier_product_offers/${offerBefore.id}`), offerBefore);
  assert.equal(reviewRecordIsTerminalDecision(documents.get("supplier_review_queue/orphan-1") || {}), true);
  assert.equal(documents.get("supplier_review_queue/orphan-1")?.decisionAction, "deleted");
  assert.match(
    writes.find((write) => write.operation === "create")?.data?.reason as string,
    new RegExp(PRELAUNCH_ORPHANED_DEAD_LETTER_CLEANUP_REASON),
  );
  assert.equal(writes.some((write) => write.key.startsWith("supplier_product_offers/")), false);
});

test("ordinary Remove still fails with revision fence for orphaned dead-letter rows", async () => {
  const { db } = orphanedFixture();
  await assert.rejects(
    decideSupplierQueueItem(
      db as never,
      "orphan-1",
      "deleted",
      { uid: "admin-1", email: "admin@zyro.lk" },
      {
        deletionReason: "review_removed_by_admin",
        expectedPendingRevision: revisionFor("orphan-1"),
      },
    ),
    /no longer pending/i,
  );
});

test("cleanup fails closed when live pendingObservation revision mismatches", () => {
  const offer = buildOffer("mismatch-1", "a2z-dropshipping", { pending: true });
  const eligibility = evaluateSupplierReviewCleanupEligibility("other-id", {
    status: "Pending",
    queueState: "dead_letter",
    supplierOfferPendingRevision: revisionFor("mismatch-1"),
    comparison: { comparisonStatus: "NEW_PRODUCT" },
  }, offer);
  assert.equal(eligibility.kind, "ineligible");
  assert.match(eligibility.reason || "", /mismatch/i);
});

test("approved, terminal, and supplier-removal rows stay excluded from cleanup", () => {
  const offer = buildOffer("x", "a2z", { pending: false });
  assert.equal(evaluateSupplierReviewCleanupEligibility("approved", {
    status: "Approved",
    queueState: "approved",
    decisionAction: "approved",
    comparison: { comparisonStatus: "NEW_PRODUCT" },
  }, offer).kind, "ineligible");
  assert.equal(evaluateSupplierReviewCleanupEligibility("terminal", {
    status: "Rejected",
    queueState: "suppressed",
    decisionAction: "deleted",
    comparison: { comparisonStatus: "NEW_PRODUCT" },
  }, offer).kind, "ineligible");
  assert.equal(evaluateSupplierReviewCleanupEligibility("removed", {
    status: "Pending",
    queueState: "review_pending",
    comparison: { comparisonStatus: "SUPPLIER_OFFER_REMOVED" },
  }, offer).kind, "ineligible");
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

test("orphaned cleanup execution routes through cleanup-only dismissal and remains idempotent", async () => {
  const offer = buildOffer("orphan-1", "a2z-dropshipping", { pending: false });
  let records = [active("orphan-1", "a2z-dropshipping", "NEW_PRODUCT", {
    status: "Pending",
    queueState: "dead_letter",
    supplierOfferPendingRevision: revisionFor("orphan-1"),
  }, offer)];
  const preview = async () => buildSupplierReviewCleanupPreview(records);
  const firstPreview = await preview();
  const orphanCalls: string[] = [];
  const dismissOrphaned = async (_db: unknown, queueItemId: unknown) => {
    orphanCalls.push(String(queueItemId));
    records = records.map((record) => record.id === queueItemId
      ? {
        ...record,
        version: `${record.version}-dismissed`,
        data: { ...record.data, status: "Rejected", queueState: "suppressed", decisionAction: "deleted" },
      }
      : record);
    return { success: true, queueItemId, action: "deleted", status: "deleted" } as const;
  };

  const first = await executeSupplierReviewCleanup(
    {} as never,
    {
      confirmation: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
      preconditionToken: firstPreview.preconditionToken,
      expectedEligibleCount: 1,
    },
    { uid: "admin-1", email: "admin@zyro.lk" },
    { preview: preview as never, dismissOrphaned: dismissOrphaned as never },
  );
  assert.deepEqual(orphanCalls, ["orphan-1"]);
  assert.equal(first.dismissed, 1);
  assert.equal(first.remainingPreview.totalEligibleActiveItems, 0);

  const second = await executeSupplierReviewCleanup(
    {} as never,
    {
      confirmation: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
      preconditionToken: first.remainingPreview.preconditionToken,
      expectedEligibleCount: 0,
    },
    { uid: "admin-1", email: "admin@zyro.lk" },
    { preview: preview as never, dismissOrphaned: dismissOrphaned as never },
  );
  assert.equal(second.processed, 0);
  assert.equal(orphanCalls.length, 1);
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

test("normal approval/remove revision fence remains in supplierApproval", () => {
  const approval = readFileSync("functions/src/api/suppliers/supplierApproval.ts", "utf8");
  assert.match(approval, /The supplier observation is no longer pending; reload Product Review\./);
  assert.match(approval, /Product Review changed after it was opened; reload before deciding\./);
  assert.doesNotMatch(approval, /prelaunch_orphaned_dead_letter_cleanup/);
});

test("future genuine supplier observation can still create a new pending revision normally", () => {
  const offer = buildOffer("future-1", "a2z-dropshipping", { pending: false });
  const withPending = buildOffer("future-1", "a2z-dropshipping", { pending: true });
  assert.equal(evaluateSupplierReviewCleanupEligibility("future-1", {
    status: "Pending",
    queueState: "dead_letter",
    supplierOfferPendingRevision: revisionFor("future-1"),
    comparison: { comparisonStatus: "NEW_PRODUCT" },
  }, offer).kind, "orphaned_dead_letter");
  assert.equal(evaluateSupplierReviewCleanupEligibility("future-1", {
    status: "Pending",
    queueState: "review_pending",
    supplierOfferPendingRevision: withPending.pendingObservation?.revision,
    comparison: { comparisonStatus: "NEW_PRODUCT" },
  }, withPending).kind, "normal_active");
});
