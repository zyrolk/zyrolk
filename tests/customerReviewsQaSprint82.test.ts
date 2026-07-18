import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  calculateProductionRatingSummary, projectProductQuestion, projectProductionReview,
  searchQuestions, sortAndFilterReviews,
} from '../src/features/reviews/reviewModel';
import {
  ReviewSystemError, calculateVoteDeltas, cleanReviewText, deterministicCustomerDocumentId,
  orderContainsProduct, selectVerifiedPurchaseOrder,
} from '../functions/src/api/reviews/reviewSystemLogic';

const component = readFileSync('src/features/reviews/ProductReviewsAndQuestions.tsx', 'utf8');
const route = readFileSync('functions/src/api/routes/reviewSystem.ts', 'utf8');
const rules = readFileSync('firestore.rules', 'utf8');
const styles = readFileSync('src/features/reviews/reviews.css', 'utf8');

const makeReview = (id: string, rating: number, helpfulCount = 0, imageUrls: string[] = []) => projectProductionReview(id, {
  productId: 'p1', userId: `u-${id}`, verifiedPurchase: true, approved: true,
  rating, title: `Review ${id}`, body: `Genuine review body ${id}`, helpfulCount, imageUrls,
  createdAt: `2026-07-${id === 'a' ? '01' : id === 'b' ? '02' : '03'}T00:00:00.000Z`,
})!;

test('verified purchase validation accepts only qualifying customer orders containing the product', () => {
  const delivered = { status: 'delivered', items: [{ productId: 'p1', quantity: 1 }] };
  assert.equal(orderContainsProduct(delivered, 'p1'), true);
  assert.equal(orderContainsProduct({ ...delivered, status: 'cancelled' }, 'p1'), false);
  assert.equal(orderContainsProduct({ ...delivered, items: [{ productId: 'other' }] }, 'p1'), false);
  assert.equal(selectVerifiedPurchaseOrder([{ id: 'o1', data: delivered }], 'p1'), 'o1');
  assert.equal(selectVerifiedPurchaseOrder([{ id: 'o2', data: { ...delivered, status: 'pending' } }], 'p1'), null);
});

test('duplicate review prevention uses one deterministic customer-product document', () => {
  const first = deterministicCustomerDocumentId('customer-1', 'product-1');
  assert.equal(first, deterministicCustomerDocumentId('customer-1', 'product-1'));
  assert.notEqual(first, deterministicCustomerDocumentId('customer-2', 'product-1'));
  assert.match(route, /transaction\.create\(reviewRef/);
  assert.match(route, /already reviewed this product/);
});

test('review projection excludes legacy, fake, unverified and invalid rating documents', () => {
  assert.equal(projectProductionReview('legacy', { productId: 'p1', userId: 'u1', rating: 5, comment: 'Legacy review' }), null);
  assert.equal(projectProductionReview('invalid', { productId: 'p1', userId: 'u1', verifiedPurchase: true, rating: 8, body: 'Invalid' }), null);
  assert.ok(makeReview('a', 5));
});

test('real rating calculations include distribution and recommendation percentage', () => {
  assert.deepEqual(calculateProductionRatingSummary([]), {
    average: 0, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, recommendationPercentage: 0,
  });
  const result = calculateProductionRatingSummary([makeReview('a', 5), makeReview('b', 4), makeReview('c', 2)]);
  assert.equal(result.average, 11 / 3);
  assert.equal(result.total, 3);
  assert.equal(result.distribution[5], 1);
  assert.equal(result.distribution[2], 1);
  assert.equal(result.recommendationPercentage, 67);
});

test('review sorting and filtering cover date, rating, helpful, verified and image modes', () => {
  const reviews = [makeReview('a', 5, 1), makeReview('b', 2, 8, ['https://example.com/image.jpg']), makeReview('c', 4, 2)];
  assert.deepEqual(sortAndFilterReviews(reviews, 'newest', 'all').map(item => item.id), ['c', 'b', 'a']);
  assert.deepEqual(sortAndFilterReviews(reviews, 'highest', 'all').map(item => item.rating), [5, 4, 2]);
  assert.deepEqual(sortAndFilterReviews(reviews, 'lowest', 'all').map(item => item.rating), [2, 4, 5]);
  assert.equal(sortAndFilterReviews(reviews, 'helpful', 'all')[0].id, 'b');
  assert.deepEqual(sortAndFilterReviews(reviews, 'newest', '5').map(item => item.id), ['a']);
  assert.deepEqual(sortAndFilterReviews(reviews, 'newest', 'images').map(item => item.id), ['b']);
});

test('helpful and not-helpful voting toggles and switches without count inflation', () => {
  assert.deepEqual(calculateVoteDeltas(undefined, 'helpful'), { helpful: 1, notHelpful: 0, removeVote: false });
  assert.deepEqual(calculateVoteDeltas('helpful', 'helpful'), { helpful: -1, notHelpful: 0, removeVote: true });
  assert.deepEqual(calculateVoteDeltas('helpful', 'not_helpful'), { helpful: -1, notHelpful: 1, removeVote: false });
});

test('question projection, CRUD controls and search use genuine Firestore content', () => {
  const question = projectProductQuestion('q1', { productId: 'p1', userId: 'u1', question: 'Does it include a warranty?', answer: 'Yes.', answered: true });
  assert.ok(question);
  assert.equal(searchQuestions([question!], 'warranty').length, 1);
  assert.equal(searchQuestions([question!], 'battery').length, 0);
  assert.match(component, /const action = editingQuestionId \? 'update' : 'create'/);
  assert.match(component, /callReviewApi\(currentUser, 'questions'/);
  assert.match(component, /action: 'delete'/);
  assert.match(component, /Reply & Mark Answered/);
});

test('ownership, unauthorized mutation protection and input sanitization are enforced server-side', () => {
  assert.match(route, /snapshot\.data\(\)\?\.userId !== user\.uid/);
  assert.match(route, /Seller access required/);
  assert.match(route, /verifyIdToken/);
  assert.match(route, /enforceRateLimit/);
  assert.equal(cleanReviewText('  safe\u0000 text  ', 'Body', 3, 30), 'safe text');
  assert.throws(() => cleanReviewText('x', 'Body', 3, 30), ReviewSystemError);
  const reviewRules = rules.slice(rules.indexOf('match /reviews/{reviewId}'), rules.indexOf('// Product Q&A'));
  assert.match(reviewRules, /allow create, update, delete: if false/);
  assert.match(rules, /match \/productQuestions\/\{questionId\}[\s\S]*allow create, update, delete: if false/);
});

test('production empty states, accessibility, responsive layout and reduced motion are present', () => {
  assert.match(component, /⭐ No ratings yet/);
  assert.match(component, /This product has not received any customer reviews yet\./);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /role=\{interactive \? 'radiogroup' : undefined\}/);
  assert.match(component, /aria-checked/);
  assert.match(component, /role="listitem"/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
