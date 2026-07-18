import { MessageSquareQuote, Star } from 'lucide-react';
import { Product } from '../types';

export interface HomepageReview {
  id?: string;
  productId?: string;
  customerName?: string;
  userName?: string;
  rating?: number;
  comment?: string;
  body?: string;
  createdAt?: string | Date | null;
  approved?: boolean;
  verifiedPurchase?: boolean;
}

interface HomepageCustomerReviewsProps {
  reviews: readonly HomepageReview[];
  products: readonly Product[];
  enabled: boolean;
}

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return 'C';
  return parts.slice(0, 2).map(part => part.charAt(0)).join('').toUpperCase();
};

export default function HomepageCustomerReviews({ reviews, products, enabled }: HomepageCustomerReviewsProps) {
  const productNames = new Map(products.map(product => [product.id, product.name]));
  const visibleReviews = enabled
    ? reviews
      .filter(review => (
        review.approved !== false &&
        review.verifiedPurchase === true &&
        typeof (review.body || review.comment) === 'string' &&
        (review.body || review.comment || '').trim().length > 0 &&
        Number.isFinite(Number(review.rating)) &&
        Number(review.rating) >= 1 &&
        Number(review.rating) <= 5
      ))
      .slice(0, 6)
    : [];
  const averageRating = visibleReviews.length > 0
    ? visibleReviews.reduce((sum, review) => sum + Number(review.rating), 0) / visibleReviews.length
    : 0;

  return (
    <section className="zy-launch-reviews" aria-labelledby="homepage-reviews-title">
      <div className="zy-launch-reviews-shell">
        <header className="zy-launch-reviews-intro">
          <span className="zy-launch-section-eyebrow">Customer feedback</span>
          <h2 id="homepage-reviews-title">Shared by Zyro.lk customers</h2>
          <p>Recent published feedback from the live marketplace review collection.</p>

          {visibleReviews.length > 0 && (
            <div className="zy-launch-reviews-summary" aria-label={`${averageRating.toFixed(1)} out of 5 from ${visibleReviews.length} displayed reviews`}>
              <strong>{averageRating.toFixed(1)}</strong>
              <div>
                <span className="zy-launch-review-stars" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map(index => (
                    <Star key={index} className={`h-4 w-4 ${index < Math.round(averageRating) ? 'is-filled' : ''}`} />
                  ))}
                </span>
                <small>{visibleReviews.length} recent {visibleReviews.length === 1 ? 'review' : 'reviews'}</small>
              </div>
            </div>
          )}
        </header>

        {visibleReviews.length > 0 ? (
          <div className="zy-launch-reviews-grid" role="list">
            {visibleReviews.map((review, index) => {
              const customerName = review.customerName?.trim() || 'Verified Customer';
              const rating = Math.round(Number(review.rating));
              const productName = review.productId ? productNames.get(review.productId) : undefined;
              const reviewBody = (review.body || review.comment || '').trim();

              return (
                <article key={review.id || `${review.productId || 'review'}-${index}`} className="zy-launch-review-card" role="listitem">
                  <div className="zy-launch-review-card-top">
                    <span className="zy-launch-review-quote" aria-hidden="true"><MessageSquareQuote className="h-5 w-5" /></span>
                    <span className="zy-launch-review-stars" aria-label={`${rating} out of 5 stars`}>
                      {[0, 1, 2, 3, 4].map(star => (
                        <Star key={star} className={`h-4 w-4 ${star < rating ? 'is-filled' : ''}`} aria-hidden="true" />
                      ))}
                    </span>
                  </div>
                  <blockquote>“{reviewBody}”</blockquote>
                  <footer>
                    <span className="zy-launch-review-avatar" aria-hidden="true">{getInitials(customerName)}</span>
                    <div>
                      <strong>{customerName}</strong>
                      <small>{productName || 'Verified purchase'}</small>
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="zy-launch-reviews-empty" role="status">
            <span aria-hidden="true"><MessageSquareQuote className="h-7 w-7" /></span>
            <div>
              <h3>{enabled ? '⭐ No ratings yet' : 'Customer reviews are currently unavailable'}</h3>
              <p>{enabled
                ? 'Genuine verified-purchase reviews will appear here when customers share them.'
                : 'Review display is currently disabled in the store settings.'}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
