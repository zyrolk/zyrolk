import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FieldValue } from "firebase-admin/firestore";
import { assertNewSupplierPublicationStock } from "../functions/src/api/suppliers/supplierApproval";
import { ProductParser as DropexProductParser } from "../functions/src/api/suppliers/dropex/ProductParser";
import {
  isDropexLowStockReviewHold,
  isSupplierProductLive,
  LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE,
  lowSupplierStockValidationError,
  supplierStockAllowsPublication,
} from "../functions/src/api/suppliers/supplierLowStockPolicy";
import {
  projectSupplierReviewLowStockHold,
  reviewRecordDecisionIsCurrent,
  reviewRecordIsActionable,
  reviewRecordIsTerminalDecision,
  reviewRecordMatchesBusinessFilter,
  SUPPLIER_REVIEW_DECISION_METADATA_FIELDS,
  supplierReviewRecordIsLowStockHold,
  supplierReviewStaleDecisionFieldDeletes,
} from "../functions/src/scheduled/supplierReviewQueue";
import { shouldDeferNewSupplierProductForZeroStock } from "../functions/src/scheduled/supplierSync";
import {
  matchesProductReviewFilter,
  supplierReviewIsLowStockHold,
  supplierReviewIsTerminalDecision,
  supplierReviewStatusLabel,
  supplierReviewStorefrontLabel,
  supplierReviewTerminalItem,
  supplierReviewTerminalLabel,
} from "../src/services/supplierHubPresentation";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

const reviewRecord = (overrides: {
  comparisonStatus?: string;
  stock?: unknown;
  stockKnown?: boolean;
  sourceId?: string;
  comparison?: Record<string, unknown>;
  approvalBaseline?: Record<string, unknown>;
  extra?: Record<string, unknown>;
} = {}): Record<string, any> => {
  const comparisonStatus = overrides.comparisonStatus ?? "NEW_PRODUCT";
  const stock = overrides.stock ?? 0;
  const stockKnown = overrides.stockKnown ?? true;
  return {
    id: "dropex-b1",
    sourceId: overrides.sourceId ?? "dropex",
    status: "Pending",
    queueState: "review_pending",
    supplierOfferPendingRevision: REVISION_A,
    comparisonStatus,
    comparison: {
      comparisonStatus,
      matchFound: false,
      matchedProductId: "legacy-slug-product",
      matchedProductLive: false,
      ...overrides.comparison,
    },
    approvalBaseline: { exists: false, ...overrides.approvalBaseline },
    matchedProductId: "legacy-slug-product",
    stock,
    productPayload: { stock, supplierMetadata: { supplierStockAvailable: stockKnown } },
    supplierSnapshot: { providedFields: stockKnown ? ["stock"] : [] },
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    ...overrides.extra,
  };
};

const expectLowStockRejection = (fn: () => void) => assert.throws(fn, (error: any) => (
  error?.statusCode === 422
  && error?.details?.validationErrors?.[0]?.code === LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE
));

test("B1-1..4 unpublished NEW_PRODUCT at stock 0-3 is held", () => {
  for (const stock of [0, 1, 2, 3]) {
    assert.equal(isDropexLowStockReviewHold({ source: "dropex", productLive: false, stockKnown: true, stock }), true);
    const projected = projectSupplierReviewLowStockHold(reviewRecord({ stock }));
    assert.equal((projected.productValidation as any).lowStockHold, true);
    assert.equal((projected.productValidation as any).readyToPublish, false);
    assert.deepEqual((projected.productValidation as any).errors, [lowSupplierStockValidationError()]);
  }
});

test("B1-5..7 unpublished PRICE_CHANGED, DESCRIPTION_CHANGED and IMAGE_CHANGED records are held independent of comparison status", () => {
  for (const [comparisonStatus, stock] of [["PRICE_CHANGED", 0], ["DESCRIPTION_CHANGED", 2], ["IMAGE_CHANGED", 3]] as const) {
    const projected = projectSupplierReviewLowStockHold(reviewRecord({ comparisonStatus, stock }));
    assert.equal(supplierReviewRecordIsLowStockHold(projected), true, comparisonStatus);
    assert.equal((projected.productValidation as any).lowStockHold, true);
    assert.equal(supplierReviewIsLowStockHold(projected), true);
    assert.equal(supplierReviewStatusLabel(projected), "Low Stock Hold");
    assert.equal(reviewRecordMatchesBusinessFilter(projected, "needs_attention"), true);
    assert.equal(matchesProductReviewFilter(projected, "needs_attention"), true);
  }
});

test("B1-8 unpublished stock 4 is not held", () => {
  assert.equal(isDropexLowStockReviewHold({ source: "dropex", productLive: false, stockKnown: true, stock: 4 }), false);
  const projected = projectSupplierReviewLowStockHold(reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 4 }));
  assert.equal((projected.productValidation as any).lowStockHold, false);
  assert.equal((projected.productValidation as any).readyToPublish, true);
});

test("B1-9 live product at stock 0 is not held", () => {
  assert.equal(isDropexLowStockReviewHold({ source: "dropex", productLive: true, stockKnown: true, stock: 0 }), false);
  const projected = projectSupplierReviewLowStockHold(reviewRecord({
    comparisonStatus: "PRICE_CHANGED",
    stock: 0,
    comparison: { matchFound: true, matchedProductLive: true },
    approvalBaseline: { exists: true },
  }));
  assert.equal((projected.productValidation as any).lowStockHold, false);
  assert.equal(isSupplierProductLive({ isActive: true, visible: true }), true);
  assert.equal(isSupplierProductLive({}), true);
  assert.equal(isSupplierProductLive({ isActive: false }), false);
  assert.equal(isSupplierProductLive({ isActive: true, visible: false }), false);
  assert.equal(isSupplierProductLive(undefined), false);
});

test("B1-10 non-Dropex behaviour is unchanged", () => {
  assert.equal(isDropexLowStockReviewHold({ source: "a2z", productLive: false, stockKnown: true, stock: 1 }), false);
  const projected = projectSupplierReviewLowStockHold(reviewRecord({ sourceId: "a2z", stock: 1 }));
  assert.equal((projected.productValidation as any).lowStockHold, false);
  assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "a2z", stock: 1, stockKnown: true }));
  assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "a2z", stock: 0, stockKnown: false }));
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: ["stock"] }, false, "a2z"), true);
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: ["stock"] }, false, "dropex"), false);
});

test("B1-11 list-time recomputation holds a legacy PRICE_CHANGED record without matchedProductLive", () => {
  const legacy = reviewRecord({ comparisonStatus: "PRICE_CHANGED", stock: 0 });
  delete (legacy.comparison as Record<string, unknown>).matchedProductLive;
  const projected = projectSupplierReviewLowStockHold(legacy);
  assert.equal((projected.productValidation as any).lowStockHold, true);
  assert.equal((projected.productValidation as any).readyToPublish, false);

  const legacyObservedProduct = reviewRecord({
    comparisonStatus: "PRICE_CHANGED",
    stock: 0,
    comparison: { matchFound: true },
    approvalBaseline: { exists: true },
  });
  delete (legacyObservedProduct.comparison as Record<string, unknown>).matchedProductLive;
  assert.equal(supplierReviewRecordIsLowStockHold(legacyObservedProduct), false);

  const inactiveExisting = reviewRecord({
    comparisonStatus: "PRICE_CHANGED",
    stock: 1,
    comparison: { matchFound: true, matchedProductLive: false },
    approvalBaseline: { exists: true },
  });
  assert.equal(supplierReviewRecordIsLowStockHold(inactiveExisting), true);
});

test("B1-12,15,18 publication guard rejects low and unknown Dropex stock", () => {
  for (const stock of [0, 1, 2, 3]) {
    expectLowStockRejection(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock, stockKnown: true }));
  }
  expectLowStockRejection(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: 10, stockKnown: false }));
  expectLowStockRejection(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: undefined, stockKnown: false }));
  expectLowStockRejection(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: 4.5, stockKnown: true }));
  expectLowStockRejection(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: "8", stockKnown: true }));
  expectLowStockRejection(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock: -1, stockKnown: true }));
  assert.equal(supplierStockAllowsPublication({ stock: 4, stockKnown: true }), true);
  assert.equal(supplierStockAllowsPublication({ stock: 3, stockKnown: true }), false);
  assert.equal(supplierStockAllowsPublication({ stock: 4, stockKnown: false }), false);
});

test("B1-13,14,16 known stock of at least four passes the publication guard", () => {
  for (const stock of [4, 5, 20]) {
    assert.doesNotThrow(() => assertNewSupplierPublicationStock({ supplierSourceId: "dropex", stock, stockKnown: true }));
  }
});

test("B1-12..18 approval decides creation from the authoritative product read and guards any not-live publication", () => {
  const approval = readFileSync("functions/src/api/suppliers/supplierApproval.ts", "utf8");
  const creation = approval.slice(approval.indexOf("const canonicalProductSnapshot"), approval.indexOf("const supplierSnapshotForIdentity"));
  assert.match(creation, /transaction\.get\(db\.collection\("products"\)\.doc\(resolvedQueueIdentity\.canonicalProductId\)\)/u);
  assert.match(creation, /!canonicalProductExists/u);
  assert.doesNotMatch(creation, /comparisonStatus|matchedProductId/u);
  assert.match(approval, /if \(action === "approved" && createsNewZyroProduct\) assertTrustedPublicationStock\(\);/u);
  assert.match(approval, /if \(!targetProductWasLive && approvalLeavesProductLive\) \{[\s\S]*?assertTrustedPublicationStock\(\);/u);
  const guardIndex = approval.indexOf("if (!targetProductWasLive && approvalLeavesProductLive)");
  const productWriteIndex = approval.indexOf("transaction.set(db.collection(\"products\").doc(decidedProductId)");
  assert.ok(guardIndex > 0 && productWriteIndex > guardIndex, "the not-live guard precedes the product write");
});

test("B1-19 a decision for an older revision is not terminal", () => {
  const stale = reviewRecord({
    extra: { decisionAction: "rejected", decisionPendingRevision: REVISION_B, supplierOfferPendingRevision: REVISION_A },
  });
  assert.equal(reviewRecordDecisionIsCurrent(stale), false);
  assert.equal(reviewRecordIsTerminalDecision(stale), false);
  assert.equal(reviewRecordIsActionable(stale), true);
  assert.equal(supplierReviewIsTerminalDecision(stale), false);
  assert.equal(supplierReviewTerminalLabel(stale), undefined);
  assert.equal(supplierReviewStorefrontLabel({ ...stale, decisionAction: "approved" }, true), "Not published");

  const staleWithoutRevision = reviewRecord({ extra: { decisionAction: "approved", supplierOfferPendingRevision: REVISION_A } });
  assert.equal(reviewRecordIsTerminalDecision(staleWithoutRevision), false);
  assert.equal(supplierReviewIsTerminalDecision(staleWithoutRevision), false);
});

test("B1-20 a decision for the current revision stays terminal; status terminal semantics are independent", () => {
  const current = reviewRecord({
    extra: { decisionAction: "deleted", decisionPendingRevision: REVISION_A, supplierOfferPendingRevision: REVISION_A },
  });
  assert.equal(reviewRecordIsTerminalDecision(current), true);
  assert.equal(supplierReviewIsTerminalDecision(current), true);
  assert.equal(supplierReviewTerminalLabel(current), "Dismissed by admin");
  const noRevisionEither = reviewRecord({ extra: { decisionAction: "rejected", supplierOfferPendingRevision: "" } });
  assert.equal(reviewRecordIsTerminalDecision(noRevisionEither), true);
  assert.equal(supplierReviewIsTerminalDecision(noRevisionEither), true);
  const statusTerminal = reviewRecord({ extra: { status: "Rejected", queueState: "rejected" } });
  assert.equal(reviewRecordIsTerminalDecision(statusTerminal), true);
  assert.equal(supplierReviewIsTerminalDecision(statusTerminal), true);
  const locallyDecided = supplierReviewTerminalItem(reviewRecord(), "rejected");
  assert.equal(locallyDecided.decisionPendingRevision, REVISION_A);
  assert.equal(supplierReviewIsTerminalDecision(locallyDecided), true);
});

test("B1-21,22 requeue clears stale decision metadata only; audit history is untouched", () => {
  const existing = {
    decisionAction: "rejected",
    decisionPendingRevision: REVISION_B,
    decisionCompletedAt: "2026-09-01T00:00:00.000Z",
    decisionCompletedBy: { uid: "admin" },
    decisionAuditId: "audit-1",
    decisionProductId: "zyro-x",
    systemDecision: "NEW_PRODUCT_DEFERRED_ZERO_STOCK",
    systemDecisionReason: "old",
    supplierOfferPendingRevision: REVISION_B,
  };
  const deletes = supplierReviewStaleDecisionFieldDeletes(existing, REVISION_A);
  assert.deepEqual(Object.keys(deletes).sort(), [...SUPPLIER_REVIEW_DECISION_METADATA_FIELDS].sort());
  for (const value of Object.values(deletes)) {
    assert.equal((value as unknown as { methodName?: string }).methodName, (FieldValue.delete() as unknown as { methodName?: string }).methodName);
  }
  assert.deepEqual(supplierReviewStaleDecisionFieldDeletes({ ...existing, decisionPendingRevision: REVISION_A }, REVISION_A), {});
  assert.deepEqual(supplierReviewStaleDecisionFieldDeletes(existing, ""), {});
  assert.deepEqual(supplierReviewStaleDecisionFieldDeletes(null, REVISION_A), {});
  assert.deepEqual(Object.keys(supplierReviewStaleDecisionFieldDeletes({ decisionAction: "approved" }, REVISION_A)), ["decisionAction"]);
  for (const field of SUPPLIER_REVIEW_DECISION_METADATA_FIELDS) {
    assert.equal(/audit/iu.test(field) && field !== "decisionAuditId", false);
  }
  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.match(sync, /supplierReviewStaleDecisionFieldDeletes\(\s*currentReview\?\.exists \? currentReview\.data\(\) : null,\s*item\.data\.supplierOfferPendingRevision,/u);
});

test("B1-23,24 stock recovery releases the hold on the same record and keeps pending changes", () => {
  const fieldChanges = [{ field: "price", before: 100, after: 120 }];
  const held = projectSupplierReviewLowStockHold(reviewRecord({
    comparisonStatus: "PRICE_CHANGED",
    stock: 0,
    extra: { pendingChangePayload: { fieldChanges } },
  }));
  assert.equal((held.productValidation as any).lowStockHold, true);
  const recovered: Record<string, any> = projectSupplierReviewLowStockHold({
    ...held,
    stock: 5,
    productPayload: { ...held.productPayload, stock: 5 },
  });
  assert.equal(recovered.id, held.id);
  assert.equal((recovered.productValidation as any).lowStockHold, false);
  assert.equal((recovered.productValidation as any).readyToPublish, true);
  assert.deepEqual(recovered.pendingChangePayload, { fieldChanges });
  assert.equal(recovered.comparisonStatus, "PRICE_CHANGED");
});

test("B1-25 sync never auto-publishes and B1-26 limited sync keeps deletion reconciliation disabled", () => {
  const sync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  assert.doesNotMatch(sync, /decideSupplierQueueItem/u);
  assert.match(sync, /const deletionReconciliationEligible = syncRequest\.mode === "full"\s*&& !supplierSyncRequestHasFilters\(syncRequest\)\s*&& !hasPersistentFilters\s*&& !Number\(syncRequest\.totalProductLimit\);/u);
  assert.match(sync, /&& traversalResult\.checkpoint\.deletionReconciliationEligible/u);
});

test("B1 invalid stock semantics: N/A still parses as known zero until the B3 parser slice", () => {
  const parsed = DropexProductParser.parseCatalogItem({ id: "b1-na", sku: "B1NA", name: "N/A stock", stock: "N/A" });
  assert.equal(parsed.inventoryLevel, 0);
  assert.ok((parsed.providedFields || []).includes("stock"));
  assert.equal(isDropexLowStockReviewHold({
    source: "dropex",
    productLive: false,
    stockKnown: (parsed.providedFields || []).includes("stock"),
    stock: parsed.inventoryLevel,
  }), true);
});
