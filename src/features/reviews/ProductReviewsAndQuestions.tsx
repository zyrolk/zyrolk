import { FormEvent, useEffect, useMemo, useState } from 'react';
import { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Flag, HelpCircle, ImagePlus,
  MessageCircleQuestion, MessageSquare, Pencil, Search, Star, ThumbsDown, ThumbsUp, Trash2,
} from 'lucide-react';
import { db } from '../../firebase';
import { reportClientIssue } from '../../services/observability/clientDiagnostics';
import { callReviewApi } from './reviewApi';
import {
  ProductQuestion, ProductionReview, ReviewFilter, ReviewSort, calculateProductionRatingSummary,
  projectProductQuestion, projectProductionReview, searchQuestions, sortAndFilterReviews,
} from './reviewModel';
import './reviews.css';

interface Props {
  productId: string;
  productName: string;
  currentUser: User | null;
}

const ADMIN_EMAIL = 'zyrolkofficial@gmail.com';
const formatDate = (date: Date | null): string => date
  ? new Intl.DateTimeFormat('en-LK', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
  : '';

function Stars({ rating, interactive = false, onChange }: { rating: number; interactive?: boolean; onChange?: (rating: number) => void }) {
  return (
    <span className="zy-review-stars" role={interactive ? 'radiogroup' : undefined} aria-label={interactive ? 'Choose a rating' : `${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((value) => interactive ? (
        <button key={value} type="button" role="radio" aria-checked={rating === value} aria-label={`${value} star${value === 1 ? '' : 's'}`} onClick={() => onChange?.(value)}>
          <Star className={value <= rating ? 'is-filled' : ''} aria-hidden="true" />
        </button>
      ) : <Star key={value} className={value <= rating ? 'is-filled' : ''} aria-hidden="true" />)}
    </span>
  );
}

export default function ProductReviewsAndQuestions({ productId, productName, currentUser }: Props) {
  const [reviews, setReviews] = useState<ProductionReview[]>([]);
  const [questions, setQuestions] = useState<ProductQuestion[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(true);
  const [loadingQuestions, setLoadingQuestions] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [eligible, setEligible] = useState(false);
  const [checkingEligibility, setCheckingEligibility] = useState(false);
  const [reviewFormOpen, setReviewFormOpen] = useState(false);
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null);
  const [reviewSort, setReviewSort] = useState<ReviewSort>('newest');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [visibleReviews, setVisibleReviews] = useState(4);
  const [questionSearch, setQuestionSearch] = useState('');
  const [questionFormOpen, setQuestionFormOpen] = useState(false);
  const [questionText, setQuestionText] = useState('');
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<{ type: 'review' | 'question'; id: string } | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = currentUser?.email?.toLowerCase() === ADMIN_EMAIL;

  useEffect(() => {
    setLoadingReviews(true);
    const unsubscribe = onSnapshot(
      query(collection(db, 'reviews'), where('productId', '==', productId)),
      (snapshot) => {
        setReviews(snapshot.docs.flatMap((document) => {
          const review = projectProductionReview(document.id, document.data());
          return review ? [review] : [];
        }));
        setLoadingReviews(false);
      },
      (reason) => {
        reportClientIssue('production-reviews-load', reason, 'warning');
        setError('Customer reviews could not be loaded. Please retry shortly.');
        setLoadingReviews(false);
      },
    );
    return unsubscribe;
  }, [productId]);

  useEffect(() => {
    setLoadingQuestions(true);
    const unsubscribe = onSnapshot(
      query(collection(db, 'productQuestions'), where('productId', '==', productId)),
      (snapshot) => {
        const projected = snapshot.docs.flatMap((document) => {
          const item = projectProductQuestion(document.id, document.data());
          return item ? [item] : [];
        }).sort((left, right) => (right.createdAt?.getTime() || 0) - (left.createdAt?.getTime() || 0));
        setQuestions(projected);
        setLoadingQuestions(false);
      },
      (reason) => {
        reportClientIssue('product-questions-load', reason, 'warning');
        setError('Product questions could not be loaded. Please retry shortly.');
        setLoadingQuestions(false);
      },
    );
    return unsubscribe;
  }, [productId]);

  useEffect(() => {
    setEligible(false);
    setReviewFormOpen(false);
    setEditingReviewId(null);
    if (!currentUser) return;
    let active = true;
    setCheckingEligibility(true);
    callReviewApi(currentUser, 'eligibility', { productId })
      .then((result) => { if (active) setEligible(result.eligible === true); })
      .catch((reason) => {
        reportClientIssue('review-eligibility-check', reason, 'warning');
        if (active) setError(reason instanceof Error ? reason.message : 'Review eligibility could not be checked.');
      })
      .finally(() => { if (active) setCheckingEligibility(false); });
    return () => { active = false; };
  }, [currentUser, productId]);

  const summary = useMemo(() => calculateProductionRatingSummary(reviews), [reviews]);
  const displayedReviews = useMemo(
    () => sortAndFilterReviews(reviews, reviewSort, reviewFilter),
    [reviewFilter, reviewSort, reviews],
  );
  const displayedQuestions = useMemo(() => searchQuestions(questions, questionSearch), [questionSearch, questions]);
  const ownReview = currentUser ? reviews.find((review) => review.userId === currentUser.uid) : undefined;

  const announce = (message: string) => {
    setStatus(message);
    setError('');
  };

  const run = async (operation: () => Promise<unknown>, successMessage: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await operation();
      announce(successMessage);
      return true;
    } catch (reason) {
      reportClientIssue('review-system-action', reason, 'warning');
      setError(reason instanceof Error ? reason.message : 'The request could not be completed.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openReviewEditor = (review?: ProductionReview) => {
    setEditingReviewId(review?.id || null);
    setReviewTitle(review?.title || '');
    setReviewBody(review?.body || '');
    setReviewRating(review?.rating || 5);
    setReviewFormOpen(true);
  };

  const submitReview = (event: FormEvent) => {
    event.preventDefault();
    if (!currentUser) return;
    const action = editingReviewId ? 'update' : 'create';
    void run(
      () => callReviewApi(currentUser, 'reviews', { action, productId, reviewId: editingReviewId, title: reviewTitle, body: reviewBody, rating: reviewRating }),
      editingReviewId ? 'Your review was updated.' : 'Your verified review was published.',
    ).then((saved) => { if (saved) {
      setReviewFormOpen(false);
      setEditingReviewId(null);
      setReviewTitle('');
      setReviewBody('');
    }});
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    if (!currentUser) return;
    const action = editingQuestionId ? 'update' : 'create';
    void run(
      () => callReviewApi(currentUser, 'questions', { action, productId, questionId: editingQuestionId, question: questionText }),
      editingQuestionId ? 'Your question was updated.' : 'Your question was posted.',
    ).then((saved) => { if (saved) {
      setQuestionFormOpen(false);
      setEditingQuestionId(null);
      setQuestionText('');
    }});
  };

  const submitReply = () => {
    if (!currentUser || !replyTarget) return;
    const path = replyTarget.type === 'review' ? 'reviews' : 'questions';
    const body = replyTarget.type === 'review'
      ? { action: 'reply', productId, reviewId: replyTarget.id, reply: replyText }
      : { action: 'reply', productId, questionId: replyTarget.id, answer: replyText };
    void run(() => callReviewApi(currentUser, path, body), 'Seller reply published.').then((saved) => { if (saved) {
      setReplyTarget(null);
      setReplyText('');
    }});
  };

  return (
    <section id="customer-reviews-section" className="zy-production-feedback" aria-labelledby="product-feedback-title">
      <div className="sr-only" aria-live="polite">{status}</div>
      {error && <div className="zy-feedback-alert" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss message">×</button></div>}

      <header className="zy-feedback-heading">
        <div><span>Genuine customer activity</span><h2 id="product-feedback-title">Reviews, ratings & product Q&amp;A</h2><p>Every rating below comes from a confirmed Zyro.lk purchase.</p></div>
        <div className="zy-feedback-heading-actions">
          {currentUser && !checkingEligibility && eligible && !ownReview && (
            <button type="button" onClick={() => openReviewEditor()}><Pencil aria-hidden="true" />{summary.total === 0 ? 'Write the First Review' : 'Write Review'}</button>
          )}
          {currentUser && <button type="button" onClick={() => { setQuestionFormOpen(true); setEditingQuestionId(null); setQuestionText(''); }}><MessageCircleQuestion aria-hidden="true" />Ask Question</button>}
        </div>
      </header>

      {loadingReviews ? (
        <div className="zy-feedback-skeleton" role="status" aria-label="Loading customer reviews"><span /><span /><span /></div>
      ) : summary.total === 0 ? (
        <div className="zy-review-empty" role="status"><strong>⭐ No ratings yet</strong><p>This product has not received any customer reviews yet.</p></div>
      ) : (
        <div className="zy-rating-summary">
          <div className="zy-rating-score"><strong>{summary.average.toFixed(1)}</strong><Stars rating={Math.round(summary.average)} /><span>{summary.total} {summary.total === 1 ? 'review' : 'reviews'}</span><b>{summary.recommendationPercentage}% recommend this product</b></div>
          <div className="zy-rating-bars" aria-label="Rating distribution">
            {[5, 4, 3, 2, 1].map((rating) => {
              const amount = summary.distribution[rating as 1 | 2 | 3 | 4 | 5];
              const percentage = Math.round((amount / summary.total) * 100);
              return <div key={rating}><span>{rating} <Star aria-hidden="true" /></span><i><b style={{ width: `${percentage}%` }} /></i><small>{percentage}% ({amount})</small></div>;
            })}
          </div>
        </div>
      )}

      {reviewFormOpen && currentUser && (eligible || Boolean(ownReview)) && (
        <form className="zy-feedback-form" onSubmit={submitReview}>
          <div><h3>{editingReviewId ? 'Edit your review' : summary.total === 0 ? 'Write the First Review' : 'Write a verified review'}</h3><button type="button" onClick={() => setReviewFormOpen(false)} aria-label="Close review form">×</button></div>
          <label>Review title<input required minLength={3} maxLength={120} value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} /></label>
          <label>Your rating<Stars rating={reviewRating} interactive onChange={setReviewRating} /></label>
          <label>Review body<textarea required minLength={10} maxLength={3000} rows={5} value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} /></label>
          <div className="zy-image-foundation"><ImagePlus aria-hidden="true" /><span><b>Review images</b><small>Image attachments are prepared for a future moderation-enabled release.</small></span></div>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : editingReviewId ? 'Save changes' : 'Publish verified review'}</button>
        </form>
      )}

      {summary.total > 0 && (
        <div className="zy-review-toolbar">
          <label>Sort reviews<select value={reviewSort} onChange={(event) => setReviewSort(event.target.value as ReviewSort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="highest">Highest Rating</option><option value="lowest">Lowest Rating</option><option value="helpful">Most Helpful</option><option value="verified">Verified Purchase</option></select></label>
          <label>Filter reviews<select value={reviewFilter} onChange={(event) => { setReviewFilter(event.target.value as ReviewFilter); setVisibleReviews(4); }}><option value="all">All Reviews</option><option value="5">5 Stars</option><option value="4">4 Stars</option><option value="3">3 Stars</option><option value="2">2 Stars</option><option value="1">1 Star</option><option value="verified">Verified Purchase</option><option value="images">With Images</option></select></label>
        </div>
      )}

      {!loadingReviews && summary.total > 0 && (
        <div className="zy-review-list" role="list">
          {displayedReviews.length === 0 ? <div className="zy-review-empty"><strong>No matching reviews</strong><p>Try another rating or review filter.</p></div> : displayedReviews.slice(0, visibleReviews).map((review) => {
            const owner = currentUser?.uid === review.userId;
            return <article key={review.id} role="listitem" className="zy-review-card">
              <header><div><strong>{review.customerName || 'Verified Customer'}</strong><span><BadgeCheck aria-hidden="true" />Verified Purchase</span></div>{review.createdAt && <time dateTime={review.createdAt.toISOString()}>{formatDate(review.createdAt)}</time>}</header>
              <Stars rating={review.rating} />
              {review.title && <h3>{review.title}</h3>}
              <p>{review.body}</p>
              {review.imageUrls.length > 0 && <div className="zy-review-images">{review.imageUrls.map((url) => <img key={url} src={url} alt="Customer review attachment" loading="lazy" decoding="async" referrerPolicy="no-referrer" />)}</div>}
              {review.sellerReply && <aside><b>Seller reply</b><p>{review.sellerReply}</p>{review.sellerReplyAt && <time dateTime={review.sellerReplyAt.toISOString()}>{formatDate(review.sellerReplyAt)}</time>}</aside>}
              <footer>
                <span>Was this helpful?</span>
                <button type="button" disabled={!currentUser || busy} onClick={() => currentUser && void run(() => callReviewApi(currentUser, 'reviews', { action: 'vote', productId, reviewId: review.id, vote: 'helpful' }), 'Helpful vote updated.')} aria-label={`Mark review by ${review.customerName || 'Verified Customer'} helpful`}><ThumbsUp aria-hidden="true" />{review.helpfulCount}</button>
                <button type="button" disabled={!currentUser || busy} onClick={() => currentUser && void run(() => callReviewApi(currentUser, 'reviews', { action: 'vote', productId, reviewId: review.id, vote: 'not_helpful' }), 'Not helpful vote updated.')} aria-label="Mark review not helpful"><ThumbsDown aria-hidden="true" />{review.notHelpfulCount}</button>
                {currentUser && !owner && <button type="button" disabled={busy} onClick={() => { const reason = window.prompt('Briefly tell us why this review should be checked.'); if (reason) void run(() => callReviewApi(currentUser, 'reviews', { action: 'report', productId, reviewId: review.id, reason }), 'Review reported for moderation.'); }}><Flag aria-hidden="true" />Report</button>}
                {owner && <><button type="button" onClick={() => openReviewEditor(review)}><Pencil aria-hidden="true" />Edit</button><button type="button" disabled={busy} onClick={() => window.confirm('Delete your review? This cannot be undone.') && currentUser && void run(() => callReviewApi(currentUser, 'reviews', { action: 'delete', productId, reviewId: review.id }), 'Your review was deleted.')}><Trash2 aria-hidden="true" />Delete</button></>}
                {isAdmin && <button type="button" onClick={() => { setReplyTarget({ type: 'review', id: review.id }); setReplyText(review.sellerReply); }}><MessageSquare aria-hidden="true" />Seller Reply</button>}
              </footer>
            </article>;
          })}
          {displayedReviews.length > 4 && <button className="zy-expand-button" type="button" onClick={() => setVisibleReviews((current) => current >= displayedReviews.length ? 4 : current + 4)}>{visibleReviews >= displayedReviews.length ? <><ChevronUp aria-hidden="true" />Collapse Reviews</> : <><ChevronDown aria-hidden="true" />Expand Reviews</>}</button>}
        </div>
      )}

      <section className="zy-product-questions" aria-labelledby="product-questions-title">
        <header><div><span>Questions &amp; Answers</span><h2 id="product-questions-title">Ask about {productName}</h2></div><label><Search aria-hidden="true" /><span className="sr-only">Search questions</span><input type="search" value={questionSearch} onChange={(event) => setQuestionSearch(event.target.value)} placeholder="Search questions" /></label></header>

        {questionFormOpen && currentUser && <form className="zy-feedback-form" onSubmit={submitQuestion}><div><h3>{editingQuestionId ? 'Edit your question' : 'Ask a product question'}</h3><button type="button" onClick={() => setQuestionFormOpen(false)} aria-label="Close question form">×</button></div><label>Your question<textarea required minLength={8} maxLength={1000} rows={4} value={questionText} onChange={(event) => setQuestionText(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? 'Saving…' : editingQuestionId ? 'Save question' : 'Post question'}</button></form>}

        {replyTarget && isAdmin && <div className="zy-seller-reply-editor"><label>Seller reply<textarea rows={4} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></label><div><button type="button" onClick={() => setReplyTarget(null)}>Cancel</button><button type="button" disabled={busy || replyText.trim().length < 2} onClick={submitReply}>Publish reply</button></div></div>}

        {loadingQuestions ? <div className="zy-feedback-skeleton" role="status" aria-label="Loading product questions"><span /><span /></div> : displayedQuestions.length === 0 ? <div className="zy-review-empty"><HelpCircle aria-hidden="true" /><strong>{questionSearch ? 'No matching questions' : 'No questions yet'}</strong><p>{questionSearch ? 'Try a different search.' : 'Be the first customer to ask about this product.'}</p></div> : <div className="zy-question-list" role="list">{displayedQuestions.map((item) => {
          const owner = currentUser?.uid === item.userId;
          return <article key={item.id} role="listitem"><header><strong>Q</strong><div><b>{item.question}</b><span>Asked by {item.customerName || 'Zyro.lk Customer'}{item.createdAt ? ` · ${formatDate(item.createdAt)}` : ''}</span></div></header>{item.answered && <div className="zy-question-answer"><strong>A</strong><div><span><CheckCircle2 aria-hidden="true" />Seller</span><p>{item.answer}</p>{item.answeredAt && <time dateTime={item.answeredAt.toISOString()}>Answered {formatDate(item.answeredAt)}</time>}</div></div>}<footer><button type="button" disabled={!currentUser || busy} onClick={() => currentUser && void run(() => callReviewApi(currentUser, 'questions', { action: 'vote', productId, questionId: item.id, vote: 'helpful' }), 'Helpful vote updated.')}><ThumbsUp aria-hidden="true" />Helpful ({item.helpfulCount})</button>{owner && <><button type="button" onClick={() => { setEditingQuestionId(item.id); setQuestionText(item.question); setQuestionFormOpen(true); }}><Pencil aria-hidden="true" />Edit</button><button type="button" disabled={busy} onClick={() => window.confirm('Delete your question?') && currentUser && void run(() => callReviewApi(currentUser, 'questions', { action: 'delete', productId, questionId: item.id }), 'Your question was deleted.')}><Trash2 aria-hidden="true" />Delete</button></>}{isAdmin && <button type="button" onClick={() => { setReplyTarget({ type: 'question', id: item.id }); setReplyText(item.answer); }}><MessageSquare aria-hidden="true" />{item.answered ? 'Edit Reply' : 'Reply & Mark Answered'}</button>}</footer></article>;
        })}</div>}
      </section>
    </section>
  );
}
