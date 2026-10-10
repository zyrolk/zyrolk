import assert from "node:assert/strict";
import test from "node:test";
import { supplierReviewCanonicalProductIds, supplierReviewRecordIsLiveEquivalent } from "../functions/src/api/suppliers/supplierReviewLiveEquivalence";

const staleReview = (overrides: Record<string, unknown> = {}) => ({
  queueState: "review_pending",
  canonicalProductId: "missing-live-product",
  productPayload: {
    id: "missing-live-product",
    isActive: true,
    published: true,
    approved: true,
  },
  ...overrides,
});

const liveProducts = (...entries: Array<[string, Record<string, unknown>]>) => new Map(entries);

test("stale embedded live-looking flags do not establish live equivalence", () => {
  assert.equal(supplierReviewRecordIsLiveEquivalent(staleReview(), liveProducts()), false);
  assert.equal(supplierReviewRecordIsLiveEquivalent(staleReview({ productPayload: { id: "missing-live-product", isActive: true } }), liveProducts()), false);
  assert.equal(supplierReviewRecordIsLiveEquivalent(staleReview({ productPayload: { id: "missing-live-product", published: true } }), liveProducts()), false);
  assert.equal(supplierReviewRecordIsLiveEquivalent(staleReview({ productPayload: { id: "missing-live-product", approved: true } }), liveProducts()), false);
});

test("the observed Pilot-10 stale review shapes remain net-new without live linkage", () => {
  const pilotIds = [
    "dropex-adl0019",
    "dropex-aju0010",
    "dropex-aju0011",
    "dropex-aju0013",
    "dropex-aju0014",
    "dropex-aju0019",
    "dropex-aju0021",
    "dropex-aju0022",
    "dropex-aju0027",
    "dropex-ajuch-3338",
  ];
  for (const productId of pilotIds) {
    const review = staleReview({
      canonicalProductId: undefined,
      productPayload: { id: productId, isActive: true, published: true, approved: true },
    });
    assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts()), false);
  }
});

test("each established exact linkage field can protect a real live product", () => {
  const fields = [
    { canonicalProductId: "canonical-live", productPayload: {} },
    { productId: "product-live", productPayload: {} },
    { matchedProductId: "matched-live", productPayload: {} },
    { comparison: { matchedProductId: "comparison-live" }, productPayload: {} },
    { productPayload: { id: "payload-live" } },
  ];
  for (const review of fields) {
    const id = supplierReviewCanonicalProductIds(review)[0]!;
    assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts([id, { isActive: true, visible: true }])), true);
  }
});

test("an existing linked live product remains protected while inactive targets fail closed", () => {
  const review = staleReview({ canonicalProductId: "live-product", productPayload: { id: "live-product", isActive: false, published: false, approved: false } });
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(["live-product", { isActive: true, visible: true }])), true);
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(["live-product", { isActive: false, visible: true }])), false);
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(["live-product", { isActive: true, visible: false }])), false);
});

test("canonical linkage resolution fails closed for broken or unrelated product references", () => {
  const review = staleReview({ canonicalProductId: "canonical-product", matchedProductId: "matched-product", productPayload: { id: "payload-product" } });
  assert.deepEqual(supplierReviewCanonicalProductIds(review), ["canonical-product", "matched-product", "payload-product"]);
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(["unrelated-product", { isActive: true, visible: true }])), false);
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(["canonical-product", { isActive: true, visible: true }])), true);
});

test("a stale reference does not mask another valid live reference", () => {
  const review = staleReview({
    canonicalProductId: "missing-canonical",
    matchedProductId: "live-match",
    comparison: { matchedProductId: "stale-comparison" },
    productPayload: { id: "live-payload", isActive: true, published: true, approved: true },
  });
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(
    ["live-match", { isActive: true, visible: true }],
  )), true);
  assert.equal(supplierReviewRecordIsLiveEquivalent(review, liveProducts(
    ["live-payload", { isActive: true, visible: true }],
  )), true);
});
