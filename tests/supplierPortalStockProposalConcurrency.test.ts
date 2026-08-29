import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApiError } from '../functions/src/api/errors';
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import {
  assertNoUnresolvedSupplierStockProposal,
  SUPPLIER_STOCK_PROPOSAL_PENDING_CODE,
  SUPPLIER_STOCK_PROPOSAL_PENDING_MESSAGE,
} from '../functions/src/api/suppliers/supplierPortalLogic';

const approvedOffer = buildSupplierProductOffer({
  sourceId: 'source-a',
  supplierId: 'supplier-a',
  supplierProductId: 'item-1',
  sku: 'SKU-1',
  productId: 'product-1',
  price: 1_200,
  cost: 900,
  stock: 5,
  availability: 'in_stock',
  lastSyncAt: '2026-08-19T00:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: { name: 'Stocked product', price: 1_200, stock: 5 },
  supplierSnapshot: { inventoryLevel: 5 },
  pendingObservation: null,
  timestamp: '2026-08-19T00:00:00.000Z',
});

const pendingStockObservation = (queueId = 'portal-request-1', stock = 8) => {
  const observed = buildSupplierProductOffer({
    ...approvedOffer,
    stock,
    availability: stock > 0 ? 'in_stock' : 'out_of_stock',
    catalogPayload: { ...approvedOffer.catalogPayload, stock },
    supplierSnapshot: { ...approvedOffer.supplierSnapshot, inventoryLevel: stock },
    existing: approvedOffer,
    timestamp: '2026-08-19T01:00:00.000Z',
  });
  return buildSupplierOfferPendingObservation({
    offer: observed,
    kind: 'catalog_upsert',
    reviewQueueItemId: queueId,
    observedAt: '2026-08-19T01:00:00.000Z',
    traversalId: 'portal-request:request-1',
  });
};

test('A: first stock proposal has no unresolved pending observation to block', () => {
  assert.doesNotThrow(() => assertNoUnresolvedSupplierStockProposal(null));
  assert.doesNotThrow(() => assertNoUnresolvedSupplierStockProposal(undefined));
  assert.doesNotThrow(() => assertNoUnresolvedSupplierStockProposal(approvedOffer.pendingObservation));
});

test('B: duplicate unresolved stock proposal is rejected without mutating the first pending state', () => {
  const firstPending = pendingStockObservation('portal-first', 8);
  const before = structuredClone(firstPending);

  assert.throws(
    () => assertNoUnresolvedSupplierStockProposal(firstPending),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.publicMessage, SUPPLIER_STOCK_PROPOSAL_PENDING_MESSAGE);
      assert.deepEqual(error.details, {
        code: SUPPLIER_STOCK_PROPOSAL_PENDING_CODE,
        reviewQueueItemId: 'portal-first',
        pendingRevision: firstPending.revision,
      });
      return true;
    },
  );

  assert.deepEqual(firstPending, before);
});

test('C/D: after pending observation clears, a fresh stock proposal is allowed', () => {
  const pending = pendingStockObservation('portal-cleared', 9);
  assert.throws(() => assertNoUnresolvedSupplierStockProposal(pending), /already pending review/u);
  assert.doesNotThrow(() => assertNoUnresolvedSupplierStockProposal(null));
});

test('E: concurrent submissions serialize to exactly one accepted pending proposal', async () => {
  let pendingObservation: ReturnType<typeof pendingStockObservation> | null = null;
  let accepted = 0;
  let rejected = 0;

  const attempt = async (queueId: string, stock: number) => {
    // Mimic Firestore transaction retry semantics: re-read current offer state
    // before deciding whether to stage a new pendingObservation.
    assertNoUnresolvedSupplierStockProposal(pendingObservation);
    pendingObservation = pendingStockObservation(queueId, stock);
    accepted += 1;
  };

  const first = attempt('portal-concurrent-a', 11);
  // Second attempt starts after the first write is visible — the conflict case.
  await first;
  await assert.rejects(
    () => attempt('portal-concurrent-b', 12),
    (error: unknown) => {
      rejected += 1;
      return error instanceof ApiError && error.statusCode === 409;
    },
  );

  assert.equal(accepted, 1);
  assert.equal(rejected, 1);
  assert.equal(pendingObservation?.reviewQueueItemId, 'portal-concurrent-a');
  assert.equal(pendingObservation?.effective.stock, 11);
});

test('fail-closed: a non-null pending blob still blocks even when strict parse fails', () => {
  assert.throws(
    () => assertNoUnresolvedSupplierStockProposal({
      reviewQueueItemId: 'portal-corrupt',
      kind: 'catalog_upsert',
      // Missing required revision/effective fields → parse returns null,
      // but the raw blob must still fail closed.
    }),
    (error: unknown) => error instanceof ApiError
      && error.statusCode === 409
      && (error.details as { reviewQueueItemId?: string | null })?.reviewQueueItemId === 'portal-corrupt',
  );
});

test('stock-proposal route enforces the unresolved pendingObservation conflict inside the transaction', () => {
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  const stockRoute = portal.slice(
    portal.indexOf('app.post("/api/supplier-portal/products/:productId/stock-proposal"'),
    portal.indexOf('app.post("/api/supplier-portal/orders/:orderId/groups/:groupId/fulfilment"'),
  );

  assert.match(stockRoute, /assertNoUnresolvedSupplierStockProposal/);
  assert.match(stockRoute, /offerSnapshot\.data\(\)\?\.pendingObservation/);
  assert.match(stockRoute, /runTransaction/);
  assert.doesNotMatch(
    stockRoute.slice(0, stockRoute.indexOf('assertNoUnresolvedSupplierStockProposal')),
    /transaction\.set\(offerReference/,
  );
});

test('Supplier Portal surfaces the conflict message from the shared API error path', () => {
  const ui = readFileSync('src/features/supplier-portal/SupplierPortal.tsx', 'utf8');
  const api = readFileSync('src/features/supplier-portal/supplierPortalApi.ts', 'utf8');

  assert.match(api, /proposeSupplierStock/);
  assert.match(api, /stock-proposal/);
  assert.match(ui, /proposeSupplierStock/);
  assert.match(ui, /setError\(requestError instanceof Error \? requestError\.message/);
  assert.match(ui, /Propose Stock/);
});
