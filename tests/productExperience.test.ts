import assert from 'node:assert/strict';
import test from 'node:test';
import { Product } from '../src/types';
import {
  PRODUCT_IMAGE_FALLBACK, LatestRequestGate, SubmissionGuard, buildProductGallery,
  calculateReviewSummary, clampGalleryIndex, getDialogEscapeAction, getFocusWrapIndex,
  groupProductSpecifications, nextGalleryIndexForKey, projectProductReview, selectRelatedProducts,
} from '../src/features/product-experience/productExperience';

const product = (id: string, overrides: Partial<Product> = {}): Product => ({
  id, name: id, description: '', price: 100, imageUrl: `/${id}.jpg`, category: 'phones',
  rating: 4, reviewsCount: 0, stock: 1, specs: {}, ...overrides,
});

test('gallery deduplicates images, supplies fallback, and clamps indexes', () => {
  assert.deepEqual(buildProductGallery(product('p', { imageUrl: '/a.jpg', imageUrls: ['/a.jpg', ' ', '/b.jpg'] })), ['/a.jpg', '/b.jpg']);
  assert.deepEqual(buildProductGallery(product('p', { imageUrl: '', imageUrls: [] })), [PRODUCT_IMAGE_FALLBACK]);
  assert.equal(clampGalleryIndex(7, 2), 1);
  assert.equal(clampGalleryIndex(-1, 2), 0);
});

test('specifications normalize, order, group, and preserve source immutability', () => {
  const specs = { warranty: '1 year', Custom_Feature: 'Yes', Brand: 'Zyro', battery: '5000mAh' };
  const snapshot = structuredClone(specs);
  assert.deepEqual(groupProductSpecifications(specs), [
    { title: 'Key Specifications', entries: [{ label: 'Brand', value: 'Zyro' }, { label: 'Battery', value: '5000mAh' }, { label: 'Warranty', value: '1 year' }] },
    { title: 'Additional Details', entries: [{ label: 'Custom Feature', value: 'Yes' }] },
  ]);
  assert.deepEqual(specs, snapshot);
});

test('related products exclude current and inactive products with deterministic ranking', () => {
  const source = product('current', { price: 100, specs: { Brand: 'A' } });
  const candidates = [product('z', { price: 90 }), product('inactive', { isActive: false }), product('b', { price: 110, specs: { Brand: 'A' } }), product('other', { category: 'audio', price: 100 })];
  assert.deepEqual(selectRelatedProducts(source, candidates).map((item) => item.id), ['b', 'z', 'other']);
  assert.equal(selectRelatedProducts(source, [source, ...candidates]).some((item) => item.id === source.id), false);
});

test('reviews project safely and calculate ratings', () => {
  const review = projectProductReview('r1', { productId: 'p', customerName: ' Sam ', rating: 4, comment: ' Great ', createdAt: '2026-01-01' });
  assert.ok(review);
  assert.equal(projectProductReview('bad', { productId: 'p', rating: 8, comment: 'bad' }), null);
  assert.deepEqual(calculateReviewSummary([review!], 2), { average: 4, distribution: [0, 0, 0, 1, 0], count: 1 });
});

test('request and submission guards prevent stale results and duplicate submits', () => {
  const requests = new LatestRequestGate();
  const first = requests.begin();
  const second = requests.begin();
  assert.equal(requests.isLatest(first), false);
  assert.equal(requests.isLatest(second), true);
  const submissions = new SubmissionGuard();
  assert.equal(submissions.begin(), true);
  assert.equal(submissions.begin(), false);
  submissions.end();
  assert.equal(submissions.begin(), true);
});

test('keyboard gallery navigation wraps and ignores unrelated keys', () => {
  assert.equal(nextGalleryIndexForKey('ArrowRight', 1, 2), 0);
  assert.equal(nextGalleryIndexForKey('ArrowLeft', 0, 2), 1);
  assert.equal(nextGalleryIndexForKey('Enter', 1, 2), 1);
});

test('modal accessibility helpers close nested UI first and wrap focus at boundaries', () => {
  assert.equal(getDialogEscapeAction(true), 'close-lightbox');
  assert.equal(getDialogEscapeAction(false), 'close-modal');
  assert.equal(getFocusWrapIndex(true, 0, 4), 3);
  assert.equal(getFocusWrapIndex(false, 3, 4), 0);
  assert.equal(getFocusWrapIndex(false, 1, 4), null);
});
