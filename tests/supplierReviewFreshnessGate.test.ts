import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
} from "../functions/src/api/suppliers/supplierOfferEngine";
import { DropexHttpError } from "../functions/src/api/suppliers/dropex/dropexHttpErrors";
import {
  attachDropexFailureDiagnostic,
  buildDropexFailureDiagnostic,
} from "../functions/src/api/suppliers/dropex/diagnostics";
import {
  buildSupplierReviewApprovalFreshnessDiagnostic,
  classifySupplierReviewApprovalFreshnessFailure,
  compareSupplierReviewFreshness,
  SUPPLIER_REVIEW_DATA_CHANGED_MESSAGE,
  SUPPLIER_REVIEW_DATA_UNVERIFIED_MESSAGE,
} from "../functions/src/scheduled/supplierSync";

const pending = (overrides: Record<string, unknown> = {}) => {
  const offer = buildSupplierProductOffer({
    sourceId: "dropex",
    supplierId: "dropex",
    supplierProductId: "4220",
    sku: "AZK1491",
    price: 656,
    cost: 487,
    stock: 74,
    stockKnown: true,
    availability: "in_stock",
    lastSyncAt: "2026-09-07T04:57:33.546Z",
    reviewStatus: "review_pending",
    catalogPayload: { name: "Seamless Suction Cup Towel Rack" },
    supplierSnapshot: {},
    timestamp: "2026-09-07T04:57:33.546Z",
    ...overrides,
  });
  return buildSupplierOfferPendingObservation({
    offer,
    kind: "catalog_upsert",
    reviewQueueItemId: "dropex-azk1491",
    observedAt: "2026-10-01T00:00:00.000Z",
    traversalId: "freshness-test",
  });
};

test("freshness comparison includes supplier identity and commercial fields", () => {
  const previous = pending();
  const current = pending({
    supplierProductId: "4221",
    sku: "AZK1492",
    price: 2_750,
    cost: 2_000,
    stock: 4,
    availability: "out_of_stock",
  });
  const comparison = compareSupplierReviewFreshness(previous, current);

  assert.equal(comparison.equivalent, false);
  assert.deepEqual(comparison.changedFields, [
    "supplier product identity",
    "supplier SKU",
    "supplier cost",
    "proposed selling price",
    "supplier stock",
    "supplier availability",
  ]);
});

test("freshness comparison ignores observation time and admin-owned listing fields", () => {
  const previous = pending();
  const current = {
    ...pending(),
    observedAt: "2026-10-01T00:05:00.000Z",
    effective: {
      ...pending().effective,
      catalogPayload: { name: "Admin-selected title" },
      supplierSnapshot: { category: "admin-owned canonical category" },
    },
  };

  assert.deepEqual(compareSupplierReviewFreshness(previous, current), {
    equivalent: true,
    changedFields: [],
  });
});

test("approval freshness responses are explicit and fail closed", () => {
  assert.match(SUPPLIER_REVIEW_DATA_CHANGED_MESSAGE, /review has been refreshed/u);
  assert.match(SUPPLIER_REVIEW_DATA_CHANGED_MESSAGE, /latest price, stock and availability/u);
  assert.match(SUPPLIER_REVIEW_DATA_UNVERIFIED_MESSAGE, /cannot be approved yet/u);
});

test("approval freshness diagnostics classify known failures without exposing the original error", () => {
  const cases = [
    [new Error("Dropex refresh catalogue request timed out."), "TIMEOUT", "exact_supplier_fetch"],
    [new DropexHttpError("Dropex authentication failed (HTTP 401).", 401, false), "HTTP_AUTH", "exact_supplier_fetch"],
    [new DropexHttpError("Dropex service is temporarily unavailable (HTTP 503).", 503, true), "HTTP_ERROR", "exact_supplier_fetch"],
    [new Error("Failed to parse Dropex refresh catalogue response as JSON."), "PARSE_ERROR", "exact_supplier_fetch"],
    [new Error("Dropex returned a product with an unexpected supplier identity."), "IDENTITY_MISMATCH", "exact_supplier_fetch"],
    [new Error("Dropex did not provide the authoritative reseller cost for this refresh."), "MISSING_COST", "commerce_validation"],
    [new Error("Dropex did not provide the authoritative proposed selling price for approval."), "MISSING_PRICE", "commerce_validation"],
    [new Error("Dropex did not provide authoritative supplier stock for approval."), "MISSING_STOCK", "commerce_validation"],
    [new Error("Current supplier availability is unavailable for approval."), "UNKNOWN_AVAILABILITY", "commerce_validation"],
  ] as const;

  for (const [error, expectedClassification, expectedStage] of cases) {
    assert.deepEqual(classifySupplierReviewApprovalFreshnessFailure(error), {
      failureClassification: expectedClassification,
      failureStage: expectedStage,
    });
  }

  const unknownError = new Error("supplier response contained bearer-secret-value");
  assert.deepEqual(classifySupplierReviewApprovalFreshnessFailure(unknownError), {
    failureClassification: "UNKNOWN",
    failureStage: "unknown",
  });
  const diagnostic = buildSupplierReviewApprovalFreshnessDiagnostic(
    "dropex-aju0027",
    unknownError,
    999_999,
    "queue-correlation-1",
  );
  assert.deepEqual(diagnostic, {
    event: "supplier_review_approval_freshness_verification_failed",
    queueItemId: "dropex-aju0027",
    failureStage: "unknown",
    failureClassification: "UNKNOWN",
    correlationId: "queue-correlation-1",
    durationMs: 300_000,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /bearer-secret-value/u);

  const rateLimitedError = new DropexHttpError("Dropex request was rate limited (HTTP 429).", 429, true);
  attachDropexFailureDiagnostic(
    rateLimitedError,
    buildDropexFailureDiagnostic(rateLimitedError, "exact_catalog_page", 1_234, { page: 3 }),
  );
  const propagated = buildSupplierReviewApprovalFreshnessDiagnostic(
    "dropex-aju0027",
    rateLimitedError,
    1_500,
    "queue-correlation-2",
  );
  assert.deepEqual(
    {
      connectorPhase: propagated.connectorPhase,
      connectorOperationPhase: propagated.connectorOperationPhase,
      connectorFailureClassification: propagated.connectorFailureClassification,
      connectorDurationMs: propagated.connectorDurationMs,
      connectorHttpStatus: propagated.connectorHttpStatus,
      connectorPage: propagated.connectorPage,
      connectorRateLimited: propagated.connectorRateLimited,
    },
    {
      connectorPhase: "deadline_abort_rate_limit",
      connectorOperationPhase: "exact_catalog_page",
      connectorFailureClassification: "RATE_LIMIT",
      connectorDurationMs: 1_234,
      connectorHttpStatus: 429,
      connectorPage: 3,
      connectorRateLimited: true,
    },
  );
});

test("approval freshness keeps the generic fail-closed response and diagnostic logging separate", () => {
  const supplierSync = readFileSync("functions/src/scheduled/supplierSync.ts", "utf8");
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.match(supplierSync, /appLogger\.warn\("Supplier review approval freshness verification failed\."/u);
  assert.match(supplierSync, /SUPPLIER_REVIEW_DATA_UNVERIFIED_MESSAGE/u);
  assert.match(supplierHub, /No approval or publication was performed/u);
  assert.doesNotMatch(supplierSync, /appLogger\.warn\([^\n]*error\s*[,)]/u);
});

test("Product Review handles freshness conflict and unresolved truth without retrying approval", () => {
  const source = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.match(source, /result\.details\?\.code === 'SUPPLIER_DATA_CHANGED'/u);
  assert.match(source, /result\.details\?\.code === 'SUPPLIER_DATA_UNVERIFIED'/u);
  assert.match(source, /SUPPLIER_REVIEW_FRESHNESS_REFRESH_MESSAGE/u);
  assert.match(source, /SUPPLIER_REVIEW_FRESHNESS_HOLD_MESSAGE/u);
  assert.match(source, /No approval or publication was performed/u);
});
