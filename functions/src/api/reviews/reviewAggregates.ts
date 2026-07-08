export interface ReviewAggregateInput {
  approved?: unknown;
  rating?: unknown;
}

export interface ReviewAggregateResult {
  rating: number;
  reviewsCount: number;
}

export function calculateReviewAggregate(reviews: ReviewAggregateInput[]): ReviewAggregateResult {
  const validRatings = reviews
    .filter((review) => review.approved !== false)
    .map((review) => review.rating)
    .filter((rating): rating is number => (
      typeof rating === "number" &&
      Number.isFinite(rating) &&
      rating >= 1 &&
      rating <= 5
    ));

  if (validRatings.length === 0) {
    return {
      rating: 0,
      reviewsCount: 0,
    };
  }

  const totalRating = validRatings.reduce((sum, rating) => sum + rating, 0);

  return {
    rating: Number((totalRating / validRatings.length).toFixed(1)),
    reviewsCount: validRatings.length,
  };
}
