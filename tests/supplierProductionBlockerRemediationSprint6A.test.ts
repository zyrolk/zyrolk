import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierOfferPublicProjection,
  buildSupplierProductOffer,
  buildSupplierRemovalPublicProjection,
  selectSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import {
  runSupplierCatalogTraversal,
  SupplierCatalogTraversalCheckpoint,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import type { SupplierCatalogPageRequest } from '../functions/src/api/suppliers/types';

const approvedOffer = (sourceId: string, overrides: Record<string, unknown> = {}) => buildSupplierProductOffer({
  sourceId,
  supplierId: sourceId,
  supplierProductId: `${sourceId}-product`,
  sku: `${sourceId}-sku`,
  barcode: `${sourceId}-barcode`,
  productId: 'product-1',
  price: 150,
  cost: 100,
  stock: 20,
  availability: 'available',
  priority: 100,
  health: { availability: 'available' },
  lastSyncAt: '2026-07-26T00:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: { originalPrice: 200 },
  supplierSnapshot: {},
  timestamp: '2026-07-26T00:00:00.000Z',
  ...overrides,
});

test('Sprint 6A advances committed pages containing invalid records and preserves reconciliation safety across resume', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  const checkpoints: SupplierCatalogTraversalCheckpoint[] = [];
  let pauseChecks = 0;
  let reconciliations = 0;
  const connector = {
    async fetchProductPage(request: SupplierCatalogPageRequest) {
      requests.push(request);
      return request.cursor === null
        ? {
          products: [{ sku: 'VALID-1' }],
          invalidProducts: 1,
          targetUrl: 'https://supplier.example/catalog',
          complete: false,
          nextCursor: 'page-2',
        }
        : {
          products: [{ sku: 'VALID-2' }],
          invalidProducts: 0,
          targetUrl: 'https://supplier.example/catalog',
          complete: true,
          nextCursor: null,
        };
    },
  };
  const partial = await runSupplierCatalogTraversal({
    connector,
    pageSize: 100,
    traversalId: 'invalid-page-traversal',
    shouldPause: () => pauseChecks++ > 0,
    processPage: async (page) => ({
      productsScanned: page.products.length,
      productsImported: page.products.length,
      invalidProducts: page.invalidProducts,
    }),
    persistCheckpoint: async (checkpoint) => { checkpoints.push({ ...checkpoint }); },
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.equal(partial.paused, true);
  assert.equal(partial.checkpoint.cursor, 'page-2');
  assert.equal(partial.checkpoint.invalidProducts, 1);
  assert.equal(partial.checkpoint.deletionReconciliationEligible, false);

  const resumed = await runSupplierCatalogTraversal({
    connector,
    pageSize: 100,
    initial: partial.checkpoint,
    processPage: async (page) => ({
      productsScanned: page.products.length,
      productsImported: page.products.length,
      invalidProducts: page.invalidProducts,
    }),
    persistCheckpoint: async (checkpoint) => { checkpoints.push({ ...checkpoint }); },
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.deepEqual(requests.map((request) => request.cursor), [null, 'page-2']);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.checkpoint.status, 'completed');
  assert.equal(resumed.checkpoint.pagesProcessed, 2);
  assert.equal(resumed.checkpoint.productsImported, 2);
  assert.equal(resumed.checkpoint.invalidProducts, 1);
  assert.equal(resumed.checkpoint.deletionReconciliationEligible, false);
  assert.equal(reconciliations, 0);
});

test('Sprint 6A product removal projects a healthy replacement or safely deactivates the storefront product', () => {
  const replacement = approvedOffer('replacement');
  const currentProduct = { price: 120, originalPrice: 180, stock: 8, isActive: true, active: true, visible: true };
  const fallbackProjection = buildSupplierRemovalPublicProjection(replacement, currentProduct, 10);

  assert.deepEqual(fallbackProjection, {
    price: 150,
    originalPrice: 200,
    discount: 25,
    stock: 18,
    availability: 'in_stock',
  });
  assert.deepEqual(buildSupplierRemovalPublicProjection(null, currentProduct, 10), {
    stock: 0,
    availability: 'unavailable',
    isActive: false,
    active: false,
    visible: false,
  });

  const approvalSource = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  assert.match(approvalSource, /reconciliationAction\) === "supplier_offer_unavailable"/);
  assert.match(approvalSource, /buildSupplierRemovalPublicProjection/);
  assert.match(approvalSource, /activeOfferId: activeCommerceOffer\?\.id \|\| \(isSupplierOfferRemoval \? null/);
});

test('Sprint 6A supplier selection atomically projects approved offer commerce fields while retaining reserved stock deltas', async () => {
  const previous = approvedOffer('previous', { price: 120, stock: 10 });
  const selected = approvedOffer('selected', { price: 150, stock: 20, priority: 200 });
  const documents = new Map<string, Record<string, unknown>>([
    ['products/product-1', { id: 'product-1', price: 120, originalPrice: 180, discount: 33, stock: 8 }],
    ['product_private/product-1', {
      supplierOfferSelection: { activeOfferId: previous.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { inventoryLevel: 10 },
    }],
  ]);
  const offers = [previous, selected];
  const writes: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  let generatedId = 0;
  const db = {
    collection(collection: string) {
      return {
        doc(id?: string) {
          return { kind: 'doc', collection, id: id || `generated-${++generatedId}` };
        },
        where() {
          return { limit: () => ({ kind: 'query', collection }) };
        },
      };
    },
    async runTransaction(callback: (transaction: Record<string, unknown>) => Promise<unknown>) {
      const transaction = {
        async get(reference: { kind: string; collection: string; id?: string }) {
          if (reference.kind === 'query') {
            return {
              docs: offers.map((offer) => ({ id: offer.id, data: () => offer })),
            };
          }
          const value = documents.get(`${reference.collection}/${reference.id}`);
          return { exists: Boolean(value), id: reference.id, data: () => value };
        },
        set(reference: { collection: string; id: string }, data: Record<string, unknown>) {
          writes.push({ collection: reference.collection, id: reference.id, data });
        },
        create(reference: { collection: string; id: string }, data: Record<string, unknown>) {
          writes.push({ collection: reference.collection, id: reference.id, data });
        },
      };
      return callback(transaction);
    },
  };

  const result = await selectSupplierProductOffer(
    db as never,
    'product-1',
    { offerId: selected.id, locked: true, failoverEnabled: true },
    { uid: 'admin-1', email: 'admin@zyro.lk' },
  );

  assert.equal(result.activeOffer?.id, selected.id);
  assert.equal(result.selection.activeOfferId, selected.id);
  const publicWrite = writes.find((write) => write.collection === 'products' && write.id === 'product-1');
  assert.equal(publicWrite?.data.price, 150);
  assert.equal(publicWrite?.data.originalPrice, 200);
  assert.equal(publicWrite?.data.stock, 18);
  assert.equal(publicWrite?.data.availability, 'in_stock');
  const privateWrite = writes.find((write) => write.collection === 'product_private' && write.id === 'product-1');
  assert.equal((privateWrite?.data.supplierOfferSelection as { activeOfferId?: string }).activeOfferId, selected.id);
});

test('Sprint 6A public offer projection never discards an intervening inventory reservation', () => {
  const projection = buildSupplierOfferPublicProjection(approvedOffer('selected'), { stock: 8, originalPrice: 180 }, 10);
  assert.equal(projection.stock, 18);
});
