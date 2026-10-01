import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
} from "../functions/src/api/suppliers/supplierOfferEngine";
import {
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

test("Product Review handles freshness conflict and unresolved truth without retrying approval", () => {
  const source = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.match(source, /result\.details\?\.code === 'SUPPLIER_DATA_CHANGED'/u);
  assert.match(source, /result\.details\?\.code === 'SUPPLIER_DATA_UNVERIFIED'/u);
  assert.match(source, /SUPPLIER_REVIEW_FRESHNESS_REFRESH_MESSAGE/u);
  assert.match(source, /SUPPLIER_REVIEW_FRESHNESS_HOLD_MESSAGE/u);
  assert.match(source, /No approval or publication was performed/u);
});
