export interface ProductionReview {
  id: string;
  productId: string;
  userId: string;
  customerName: string;
  title: string;
  body: string;
  rating: number;
  verifiedPurchase: true;
  createdAt: Date | null;
  updatedAt: Date | null;
  imageUrls: string[];
  helpfulCount: number;
  notHelpfulCount: number;
  sellerReply: string;
  sellerReplyAt: Date | null;
}

export interface ProductQuestion {
  id: string;
  productId: string;
  userId: string;
  customerName: string;
  question: string;
  answer: string;
  answered: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  answeredAt: Date | null;
  helpfulCount: number;
  notHelpfulCount: number;
}

export interface RatingSummary {
  average: number;
  total: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  recommendationPercentage: number;
}

export type ReviewSort = 'newest' | 'oldest' | 'highest' | 'lowest' | 'helpful' | 'verified';
export type ReviewFilter = 'all' | '5' | '4' | '3' | '2' | '1' | 'verified' | 'images';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const count = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

export function dateFromFirestore(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const result = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(result.getTime()) ? result : null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result : null;
  }
  return null;
}

export function projectProductionReview(id: string, data: Record<string, unknown>): ProductionReview | null {
  const rating = Number(data.rating);
  const productId = text(data.productId);
  const userId = text(data.userId);
  const body = text(data.body) || text(data.comment);
  if (
    data.verifiedPurchase !== true ||
    data.approved === false ||
    !productId ||
    !userId ||
    !body ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) return null;
  return {
    id,
    productId,
    userId,
    customerName: text(data.customerName),
    title: text(data.title),
    body,
    rating,
    verifiedPurchase: true,
    createdAt: dateFromFirestore(data.createdAt),
    updatedAt: dateFromFirestore(data.updatedAt),
    imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls.map(text).filter(Boolean) : [],
    helpfulCount: count(data.helpfulCount),
    notHelpfulCount: count(data.notHelpfulCount),
    sellerReply: text(data.sellerReply),
    sellerReplyAt: dateFromFirestore(data.sellerReplyAt),
  };
}

export function projectProductQuestion(id: string, data: Record<string, unknown>): ProductQuestion | null {
  const productId = text(data.productId);
  const userId = text(data.userId);
  const question = text(data.question);
  if (!productId || !userId || !question) return null;
  const answer = text(data.answer);
  return {
    id,
    productId,
    userId,
    customerName: text(data.customerName),
    question,
    answer,
    answered: data.answered === true && Boolean(answer),
    createdAt: dateFromFirestore(data.createdAt),
    updatedAt: dateFromFirestore(data.updatedAt),
    answeredAt: dateFromFirestore(data.answeredAt),
    helpfulCount: count(data.helpfulCount),
    notHelpfulCount: count(data.notHelpfulCount),
  };
}

export function calculateProductionRatingSummary(reviews: readonly ProductionReview[]): RatingSummary {
  const distribution: RatingSummary['distribution'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalRating = 0;
  let recommended = 0;
  reviews.forEach((review) => {
    distribution[review.rating as 1 | 2 | 3 | 4 | 5] += 1;
    totalRating += review.rating;
    if (review.rating >= 4) recommended += 1;
  });
  return {
    average: reviews.length ? totalRating / reviews.length : 0,
    total: reviews.length,
    distribution,
    recommendationPercentage: reviews.length ? Math.round((recommended / reviews.length) * 100) : 0,
  };
}

export function sortAndFilterReviews(
  reviews: readonly ProductionReview[],
  sort: ReviewSort,
  filter: ReviewFilter,
): ProductionReview[] {
  const filtered = reviews.filter((review) => {
    if (filter === 'verified') return review.verifiedPurchase;
    if (filter === 'images') return review.imageUrls.length > 0;
    if (filter !== 'all') return review.rating === Number(filter);
    return true;
  });
  return [...filtered].sort((left, right) => {
    const leftTime = left.createdAt?.getTime() || 0;
    const rightTime = right.createdAt?.getTime() || 0;
    if (sort === 'oldest') return leftTime - rightTime;
    if (sort === 'highest') return right.rating - left.rating || rightTime - leftTime;
    if (sort === 'lowest') return left.rating - right.rating || rightTime - leftTime;
    if (sort === 'helpful') return right.helpfulCount - left.helpfulCount || rightTime - leftTime;
    if (sort === 'verified') return Number(right.verifiedPurchase) - Number(left.verifiedPurchase) || rightTime - leftTime;
    return rightTime - leftTime;
  });
}

export function searchQuestions(questions: readonly ProductQuestion[], query: string): ProductQuestion[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...questions];
  return questions.filter((item) => `${item.question} ${item.answer}`.toLocaleLowerCase().includes(normalized));
}
