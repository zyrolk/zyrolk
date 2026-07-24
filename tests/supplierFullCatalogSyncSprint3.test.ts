import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SupplierCatalogPageRequest, SupplierCatalogPageResult } from '../functions/src/api/suppliers/types';
import {
  createSupplierCatalogTraversalCheckpoint,
  runSupplierCatalogTraversal,
  SupplierCatalogTraversalCheckpoint,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import {
  buildSupplierRemovalProductPayload,
  isSupplierProductEligibleForRemovalReview,
} from '../functions/src/scheduled/supplierSync';

const pagedConnector = (total: number, requests: SupplierCatalogPageRequest[]) => ({
  async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    requests.push(request);
    const offset = Number(request.cursor || 0);
    const count = Math.min(request.pageSize, total - offset);
    const products = Array.from({ length: Math.max(0, count) }, (_, index) => ({
      sku: `SKU-${offset + index}`,
      title: `Product ${offset + index}`,
    }));
    const nextOffset = offset + products.length;
    return {
      products,
      targetUrl: 'https://supplier.example/catalog',
      complete: nextOffset >= total,
      nextCursor: nextOffset >= total ? null : String(nextOffset),
    };
  },
});

test('Sprint 3 traverses every connector page and reconciles only after verified completion', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  const checkpoints: SupplierCatalogTraversalCheckpoint[] = [];
  let reconciliations = 0;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(250, requests),
    pageSize: 100,
    traversalId: 'traversal-1',
    processPage: async (page) => ({ productsScanned: page.products.length, productsImported: page.products.length }),
    persistCheckpoint: async (checkpoint) => { checkpoints.push({ ...checkpoint }); },
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.deepEqual(requests.map((request) => request.cursor), [null, '100', '200']);
  assert.equal(result.complete, true);
  assert.equal(result.checkpoint.pagesProcessed, 3);
  assert.equal(result.checkpoint.productsScanned, 250);
  assert.equal(result.checkpoint.productsImported, 250);
  assert.equal(reconciliations, 1);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.status), ['in_progress', 'in_progress', 'reconciling', 'completed']);
});

test('Sprint 3 persists a forward cursor and resumes after a timeout without restarting page one', async () => {
  const firstRequests: SupplierCatalogPageRequest[] = [];
  const persisted: SupplierCatalogTraversalCheckpoint[] = [];
  let pauseChecks = 0;
  let reconciliations = 0;
  const partial = await runSupplierCatalogTraversal({
    connector: pagedConnector(220, firstRequests),
    pageSize: 100,
    traversalId: 'traversal-timeout',
    shouldPause: () => pauseChecks++ > 0,
    processPage: async (page) => ({ productsScanned: page.products.length, productsImported: 0 }),
    persistCheckpoint: async (checkpoint) => { persisted.push({ ...checkpoint }); },
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.equal(partial.paused, true);
  assert.equal(partial.checkpoint.cursor, '100');
  assert.equal(reconciliations, 0);

  const resumeRequests: SupplierCatalogPageRequest[] = [];
  const resumed = await runSupplierCatalogTraversal({
    connector: pagedConnector(220, resumeRequests),
    pageSize: 100,
    initial: partial.checkpoint,
    processPage: async (page) => ({ productsScanned: page.products.length, productsImported: 0 }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });
  assert.equal(resumeRequests[0].cursor, '100');
  assert.equal(resumed.checkpoint.resumeCount, 1);
  assert.equal(resumed.checkpoint.productsScanned, 220);
  assert.equal(reconciliations, 1);
});

test('Sprint 3 connector failure retains the last successful checkpoint and never starts deletion reconciliation', async () => {
  let calls = 0;
  let lastCheckpoint: SupplierCatalogTraversalCheckpoint | undefined;
  let reconciled = false;
  const connector = {
    async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
      calls += 1;
      if (calls === 2) throw new Error('connector unavailable');
      return {
        products: [{ sku: 'SKU-1' }], targetUrl: 'https://supplier.example', complete: false, nextCursor: 'page-2',
      };
    },
  };
  await assert.rejects(() => runSupplierCatalogTraversal({
    connector,
    pageSize: 100,
    traversalId: 'traversal-failure',
    processPage: async () => ({ productsScanned: 1, productsImported: 1 }),
    persistCheckpoint: async (checkpoint) => { lastCheckpoint = { ...checkpoint }; },
    reconcileDeletedProducts: async () => { reconciled = true; },
  }), /connector unavailable/);
  assert.equal(lastCheckpoint?.cursor, 'page-2');
  assert.equal(lastCheckpoint?.status, 'in_progress');
  assert.equal(reconciled, false);
});

test('Sprint 3 resumes interrupted delete reconciliation without fetching or deleting products directly', async () => {
  const checkpoint = createSupplierCatalogTraversalCheckpoint({}, { traversalId: 'reconcile-resume', now: 1_000 });
  let fetches = 0;
  let reconciliations = 0;
  const result = await runSupplierCatalogTraversal({
    connector: { async fetchProductPage() { fetches += 1; throw new Error('must not fetch'); } },
    pageSize: 100,
    initial: { ...checkpoint, status: 'reconciling' },
    processPage: async () => ({ productsScanned: 0, productsImported: 0 }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });
  assert.equal(fetches, 0);
  assert.equal(reconciliations, 1);
  assert.equal(result.checkpoint.status, 'completed');

  const removalPayload = buildSupplierRemovalProductPayload(
    'product-1',
    { name: 'Missing product', stock: 8, isActive: true, visible: true },
    { supplierItemCode: 'SUP-1', costPrice: 100, supplierCatalogTraversalId: 'private-marker' },
  );
  assert.equal(removalPayload.stock, 0);
  assert.equal(removalPayload.isActive, false);
  assert.equal(removalPayload.visible, false);
  assert.equal(removalPayload.supplierItemCode, 'SUP-1');
  assert.equal(removalPayload.supplierCatalogTraversalId, undefined);
  assert.equal(isSupplierProductEligibleForRemovalReview({ isActive: true, active: true, visible: true }), true);
  assert.equal(isSupplierProductEligibleForRemovalReview({ isActive: false }), false);
});

test('Sprint 3 keeps large catalogs page-bounded and advances checkpoints after each committed page', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  const events: string[] = [];
  let maximumPageSize = 0;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(2_500, requests),
    pageSize: 100,
    traversalId: 'large-catalog',
    processPage: async (page) => {
      maximumPageSize = Math.max(maximumPageSize, page.products.length);
      events.push(`processed:${page.products.length}`);
      return { productsScanned: page.products.length, productsImported: 0 };
    },
    persistCheckpoint: async (checkpoint) => { events.push(`persisted:${checkpoint.pagesProcessed}`); },
    reconcileDeletedProducts: async () => { events.push('reconciled'); },
  });
  assert.equal(result.checkpoint.productsScanned, 2_500);
  assert.equal(result.checkpoint.pagesProcessed, 25);
  assert.equal(requests.length, 25);
  assert.equal(maximumPageSize, 100);
  assert.deepEqual(events.slice(0, 2), ['processed:100', 'persisted:1']);
  assert.equal(events.at(-2), 'reconciled');
  assert.equal(events.at(-1), 'persisted:25');
});

test('Sprint 3 production sync uses connector pages, persistent cursors, and full-traversal-only reconciliation', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const types = readFileSync('functions/src/api/suppliers/types.ts', 'utf8');
  const a2z = readFileSync('functions/src/api/suppliers/a2z/A2ZSupplierConnector.ts', 'utf8');
  const http = readFileSync('functions/src/api/suppliers/HttpSupplierConnector.ts', 'utf8');
  assert.match(types, /fetchProductPage\(request: SupplierCatalogPageRequest\)/);
  assert.match(a2z, /fetchCatalogPage/);
  assert.match(readFileSync('functions/src/api/suppliers/a2z/A2ZConnectorService.ts', 'utf8'), /productsForPage\.length < pageSize/);
  assert.match(http, /public async fetchProductPage/);
  assert.match(http, /requestUrl\.searchParams\.set\("offset", request\.cursor\)/);
  assert.match(http, /products\.length < pageSize/);
  assert.match(sync, /runSupplierCatalogTraversal/);
  assert.match(sync, /catalogCursor: checkpoint\.cursor/);
  assert.match(sync, /supplierCatalogTraversalId/);
  assert.match(sync, /queueMissingSupplierProductsForReview/);
  assert.match(sync, /reconciliationAction: "deactivate_and_zero_stock"/);
  assert.doesNotMatch(sync, /const fetched = await connector\.fetchProducts\(\)/);
});
