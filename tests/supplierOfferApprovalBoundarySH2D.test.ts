import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSupplierOfferObservationWrite,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  buildSupplierOfferPublicProjection,
  promoteSupplierOfferPendingObservation,
  resolveActiveSupplierOffer,
  supplierOfferEligibilityChanged,
  supplierOfferStateExpectation,
  supplierOfferStateMatchesExpectation,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import {
  buildLegacySupplierRemovalReviewId,
  buildSupplierOfferRemovalReviewId,
} from '../functions/src/scheduled/supplierSync';

const effectiveOffer = buildSupplierProductOffer({
  sourceId: 'source-a',
  supplierId: 'supplier-a',
  supplierProductId: 'supplier-product-1',
  sku: 'SKU-1',
  barcode: '1234567890123',
  productId: 'product-1',
  price: 100,
  cost: 70,
  stock: 10,
  availability: 'available',
  priority: 100,
  health: { availability: 'available', observedAt: '2026-08-01T00:00:00.000Z' },
  lastSyncAt: '2026-08-01T00:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: { name: 'Approved product', price: 100, stock: 10 },
  supplierSnapshot: { title: 'Approved product', wholesalePrice: 70, stock: 10 },
  timestamp: '2026-08-01T00:00:00.000Z',
});

const observedOffer = (overrides: Record<string, unknown> = {}) => buildSupplierProductOffer({
  sourceId: effectiveOffer.sourceId,
  supplierId: effectiveOffer.supplierId,
  supplierProductId: effectiveOffer.supplierProductId,
  sku: effectiveOffer.sku,
  barcode: effectiveOffer.barcode,
  productId: effectiveOffer.productId,
  price: 120,
  cost: 80,
  stock: 0,
  availability: 'out_of_stock',
  priority: effectiveOffer.priority,
  health: { availability: 'available', observedAt: '2026-08-02T00:00:00.000Z' },
  lastSyncAt: '2026-08-02T00:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: { name: 'Observed product', price: 120, stock: 0 },
  supplierSnapshot: { title: 'Observed product', wholesalePrice: 80, stock: 0 },
  existing: effectiveOffer,
  timestamp: '2026-08-02T00:00:00.000Z',
  ...overrides,
});

test('SH-2D stages price, cost and stock without mutating approved effective state', () => {
  const observed = observedOffer();
  const pending = buildSupplierOfferPendingObservation({
    offer: observed,
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-08-02T00:00:00.000Z',
    traversalId: 'traversal-1',
  });
  const write = buildSupplierOfferObservationWrite({
    existing: effectiveOffer,
    observed,
    pending,
    traversalId: 'traversal-1',
    observedAt: '2026-08-02T00:00:00.000Z',
  });
  const staged = { ...effectiveOffer, ...write };

  assert.equal(staged.price, 100);
  assert.equal(staged.cost, 70);
  assert.equal(staged.stock, 10);
  assert.equal(staged.availability, 'in_stock');
  assert.equal(staged.reviewStatus, 'approved');
  assert.equal(staged.pendingObservation.effective.price, 120);
  assert.equal(staged.pendingObservation.effective.stock, 0);
  assert.equal(supplierOfferEligibilityChanged(effectiveOffer, staged), false);
});

test('SH-2D pending observations cannot influence offer selection or public projection', () => {
  const observed = observedOffer({ availability: 'unavailable' });
  const pending = buildSupplierOfferPendingObservation({
    offer: observed,
    kind: 'catalog_removal',
    reviewQueueItemId: 'removal-review',
    observedAt: '2026-08-02T00:00:00.000Z',
    traversalId: 'traversal-2',
  });
  const staged = {
    ...effectiveOffer,
    ...buildSupplierOfferObservationWrite({
      existing: effectiveOffer,
      observed,
      pending,
      traversalId: 'traversal-2',
      observedAt: '2026-08-02T00:00:00.000Z',
    }),
  };

  assert.equal(resolveActiveSupplierOffer([staged], {})?.id, effectiveOffer.id);
  assert.equal(buildSupplierOfferPublicProjection(staged, { stock: 10 }).price, 100);
  assert.throws(() => buildSupplierOfferPublicProjection({ ...observed, reviewStatus: 'review_pending' }, { stock: 10 }), /approved supplier offer/i);
});

test('SH-2D observation revisions are deterministic and exact promotion is fenced', () => {
  const first = buildSupplierOfferPendingObservation({
    offer: observedOffer(),
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-08-02T00:00:00.000Z',
    traversalId: 'traversal-1',
  });
  const retry = buildSupplierOfferPendingObservation({
    offer: observedOffer({
      health: { availability: 'available', observedAt: '2026-08-03T00:00:00.000Z' },
      lastSyncAt: '2026-08-03T00:00:00.000Z',
      timestamp: '2026-08-03T00:00:00.000Z',
    }),
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-08-03T00:00:00.000Z',
    traversalId: 'traversal-2',
  });
  const changed = buildSupplierOfferPendingObservation({
    offer: observedOffer({ price: 130 }),
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-08-03T00:00:00.000Z',
    traversalId: 'traversal-2',
  });

  assert.equal(first.revision, retry.revision);
  assert.notEqual(first.revision, changed.revision);
  const staged = { ...effectiveOffer, stateVersion: 1, pendingObservation: first };
  const promoted = promoteSupplierOfferPendingObservation(staged, first.revision);
  assert.equal(promoted.price, 120);
  assert.equal(promoted.stock, 0);
  assert.equal(promoted.pendingObservation, null);
  assert.throws(() => promoteSupplierOfferPendingObservation(staged, changed.revision), /changed after it was reviewed/i);
});

test('SH-2D optimistic offer state fence rejects stale sync state', () => {
  const expected = supplierOfferStateExpectation(effectiveOffer);
  assert.equal(supplierOfferStateMatchesExpectation(effectiveOffer, expected, true), true);
  assert.equal(supplierOfferStateMatchesExpectation({ ...effectiveOffer, stateVersion: 1 }, expected, true), false);
  assert.equal(supplierOfferStateMatchesExpectation(undefined, { exists: false, stateVersion: 0, pendingRevision: null }, false), true);
});

test('SH-2D removal review identity is stable per unresolved lifecycle', () => {
  const active = buildSupplierOfferRemovalReviewId(effectiveOffer.id);
  assert.equal(active, buildSupplierOfferRemovalReviewId(effectiveOffer.id));
  assert.equal(active.includes('traversal'), false);
  assert.notEqual(buildSupplierOfferRemovalReviewId(effectiveOffer.id, 3, true), active);

  const legacy = buildLegacySupplierRemovalReviewId('source-a', 'product-1');
  assert.equal(legacy, buildLegacySupplierRemovalReviewId('source-a', 'product-1'));
  assert.notEqual(buildLegacySupplierRemovalReviewId('source-a', 'product-1', 'reactivation-2', true), legacy);
});
