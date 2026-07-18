import assert from "node:assert/strict";
import test from "node:test";
import { calculateReviewAggregate } from "../functions/src/api/reviews/reviewAggregates";

test("review aggregate recalculates after review creation", () => {
  assert.deepEqual(calculateReviewAggregate([{ rating: 5, verifiedPurchase: true }, { rating: 4, verifiedPurchase: true }]), {
    rating: 4.5,
    reviewsCount: 2,
  });
});

test("review aggregate recalculates after review update", () => {
  assert.deepEqual(calculateReviewAggregate([{ rating: 2, verifiedPurchase: true }, { rating: 4, verifiedPurchase: true }]), {
    rating: 3,
    reviewsCount: 2,
  });
});

test("review aggregate recalculates after review deletion", () => {
  assert.deepEqual(calculateReviewAggregate([{ rating: 5, verifiedPurchase: true }]), {
    rating: 5,
    reviewsCount: 1,
  });
});

test("review aggregate ignores rejected and invalid reviews", () => {
  assert.deepEqual(calculateReviewAggregate([
    { rating: 5, verifiedPurchase: true },
    { rating: 1, approved: false, verifiedPurchase: true },
    { rating: 10, verifiedPurchase: true },
    { rating: "bad", verifiedPurchase: true },
    { rating: 5 },
  ]), {
    rating: 5,
    reviewsCount: 1,
  });
});
