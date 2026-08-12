import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectorSyncCapabilities,
} from '../functions/src/api/suppliers/types';
import { RawA2ZProduct } from '../functions/src/api/suppliers/a2z/types';
import {
  applyServerSideSupplierCatalogFilters,
  assertSupplierSyncRequestSupported,
  buildFilteredSupplierOfferSightings,
  matchesSupplierCatalogSearch,
} from '../functions/src/scheduled/supplierSync';
import { resolveSupplierIncrementalCatalogRequest } from '../functions/src/api/suppliers/supplierSyncRequest';
import {
  runSupplierCatalogTraversal,
  SupplierCatalogTraversalCheckpoint,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import { buildSupplierOfferId } from '../functions/src/api/suppliers/supplierOfferEngine';

const unsupportedCapabilities: SupplierConnectorSyncCapabilities = {
  incremental: { supported: false, mechanism: 'unsupported', deletionSemantics: 'none' },
  categoryFilter: 'server_side',
  subcategoryFilter: 'server_side',
  searchFilter: 'server_side',
};

const incrementalCapabilities: SupplierConnectorSyncCapabilities = {
  incremental: { supported: true, mechanism: 'updated_since', deletionSemantics: 'none' },
  categoryFilter: 'server_side',
  subcategoryFilter: 'server_side',
  searchFilter: 'server_side',
};

function product(overrides: Partial<RawA2ZProduct> = {}): RawA2ZProduct {
  return {
    sku: 'PHONE-001',
    supplierProductId: 'supplier-phone-1',
    barcode: '479000000001',
    title: 'Samsung Galaxy Phone',
    brand: 'Samsung',
    supplierCategory: 'Electronics',
    supplierSubcategory: 'Phones',
    categoryHierarchy: ['Electronics', 'Phones'],
    longDescription: 'Supplier phone description',
    mediaGallery: ['https://supplier.example/phone.jpg'],
    wholesalePrice: 100,
    recommendedRetailPrice: 120,
    inventoryLevel: 5,
    ...overrides,
  };
}

function pagedConnector(
  total: number,
  requests: SupplierCatalogPageRequest[],
  syncCapabilities: SupplierConnectorSyncCapabilities = unsupportedCapabilities,
) {
  return {
    syncCapabilities,
    async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
      requests.push(structuredClone(request));
      const offset = Number(request.cursor || 0);
      const count = Math.max(0, Math.min(request.pageSize, total - offset));
      const products = Array.from({ length: count }, (_, index) => product({
        sku: `SKU-${offset + index}`,
        supplierProductId: `product-${offset + index}`,
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
  };
}

const processEntirePage = async (page: SupplierCatalogPageResult) => ({
  productsScanned: page.products.length,
  productsImported: page.products.length,
});

test('SH-2B full mode and request controls propagate to the connector', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  let reconciliations = 0;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(1, requests),
    pageSize: 25,
    syncMode: 'full',
    filters: { category: 'Electronics' },
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, 'full');
  assert.equal(requests[0].pageSize, 25);
  assert.deepEqual(requests[0].filters, { category: 'Electronics' });
  assert.equal(requests[0].incremental, undefined);
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
  assert.equal(reconciliations, 0, 'the traversal boundary must never treat a filtered page as deletion proof');
});

test('SH-2B unsupported incremental mode is rejected before connector retrieval', async () => {
  let fetches = 0;
  const connector = {
    syncCapabilities: unsupportedCapabilities,
    async fetchProductPage(): Promise<SupplierCatalogPageResult> {
      fetches += 1;
      throw new Error('must not fetch');
    },
  };

  assert.throws(
    () => assertSupplierSyncRequestSupported(connector, { mode: 'incremental' }),
    /does not support true incremental synchronization/,
  );
  await assert.rejects(() => runSupplierCatalogTraversal({
    connector,
    pageSize: 20,
    syncMode: 'incremental',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  }), /does not support true incremental synchronization/);
  assert.equal(fetches, 0);
});

test('SH-2B supported incremental connector receives native delta criteria and never reconciles removals', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  let reconciliations = 0;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(1, requests, incrementalCapabilities),
    pageSize: 20,
    syncMode: 'incremental',
    incremental: {
      updatedSince: '2026-07-01T00:00:00.000Z',
      deltaToken: 'delta-7',
    },
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.deepEqual(requests[0].incremental, {
    updatedSince: '2026-07-01T00:00:00.000Z',
    deltaToken: 'delta-7',
  });
  assert.equal(result.complete, true);
  assert.equal(result.checkpoint.syncMode, 'incremental');
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
  assert.equal(result.checkpoint.terminationReason, 'incremental_complete');
  assert.equal(reconciliations, 0);
});

test('SH-2B incremental admission fails closed without a trustworthy completed baseline', () => {
  assert.throws(() => resolveSupplierIncrementalCatalogRequest(incrementalCapabilities, {}), /requires a completed full or incremental traversal baseline/);
  assert.throws(() => resolveSupplierIncrementalCatalogRequest(incrementalCapabilities, {
    lastCompletedCatalogTraversal: {
      completedAt: '2026-07-02T00:00:00.000Z',
    },
  }), /requires a completed full or incremental traversal baseline/);
});

test('SH-2B updated-since incremental uses the newest completed traversal start, never completion time', () => {
  const request = resolveSupplierIncrementalCatalogRequest(incrementalCapabilities, {
    lastCompletedCatalogTraversal: {
      startedAt: '2026-07-01T08:00:00.000Z',
      completedAt: '2026-07-01T10:00:00.000Z',
    },
    lastCompletedIncrementalTraversal: {
      startedAt: '2026-07-02T08:30:00.000Z',
      completedAt: '2026-07-02T09:00:00.000Z',
    },
  });

  assert.deepEqual(request, { updatedSince: '2026-07-02T08:30:00.000Z' });
  assert.notEqual(request.updatedSince, '2026-07-02T09:00:00.000Z');
});

for (const mechanism of ['delta_token', 'change_cursor'] as const) {
  test(`SH-2B ${mechanism} incremental requires and returns the newest completed baseline token`, () => {
    const capabilities: SupplierConnectorSyncCapabilities = {
      ...incrementalCapabilities,
      incremental: { supported: true, mechanism, deletionSemantics: 'none' },
    };
    assert.deepEqual(resolveSupplierIncrementalCatalogRequest(capabilities, {
      lastCompletedCatalogTraversal: {
        startedAt: '2026-07-01T08:00:00.000Z',
        completedAt: '2026-07-01T09:00:00.000Z',
        deltaToken: 'old-token',
      },
      lastCompletedIncrementalTraversal: {
        startedAt: '2026-07-02T08:00:00.000Z',
        completedAt: '2026-07-02T08:30:00.000Z',
        deltaToken: 'new-token',
      },
    }), { deltaToken: 'new-token' });
    assert.throws(() => resolveSupplierIncrementalCatalogRequest(capabilities, {
      lastCompletedIncrementalTraversal: {
        startedAt: '2026-07-02T08:00:00.000Z',
        completedAt: '2026-07-02T08:30:00.000Z',
      },
    }), /requires a completed baseline token/);
  });
}

test('SH-2B category, subcategory, and search filters execute deterministically server-side', () => {
  const selected = product();
  const unrelated = product({
    sku: 'SHOE-002',
    supplierProductId: 'supplier-shoe-2',
    barcode: '479000000002',
    title: 'Running Shoe',
    brand: 'Acme',
    supplierCategory: 'Fashion',
    supplierSubcategory: 'Shoes',
    categoryHierarchy: ['Fashion', 'Shoes'],
  });
  const filtered = applyServerSideSupplierCatalogFilters(
    [selected, unrelated],
    { syncCapabilities: unsupportedCapabilities },
    {
      mode: 'full',
      filters: { category: 'Electronics', subcategory: 'Phones', search: 'samsung' },
    },
    [{ id: 'electronics', name: 'Electronics' }, { id: 'fashion', name: 'Fashion' }],
    undefined,
  );

  assert.deepEqual(filtered.map((item) => item.sku), ['PHONE-001']);
  for (const query of ['galaxy', 'supplier-phone-1', 'phone-001', '479000000001', 'samsung']) {
    assert.equal(matchesSupplierCatalogSearch(selected, query), true, `${query} should match a supported field`);
  }
  assert.equal(matchesSupplierCatalogSearch(selected, 'unrelated phrase'), false);
});

test('SH-2B totalProductLimit bounds the whole traversal while pageSize remains independent', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  let reconciliations = 0;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, requests),
    pageSize: 7,
    totalProductLimit: 20,
    requestFingerprint: 'limit-20',
    syncJobId: 'job-limit-20',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  });

  assert.deepEqual(requests.map((request) => request.pageSize), [7, 7, 6]);
  assert.deepEqual(requests.map((request) => request.cursor), [null, '7', '14']);
  assert.equal(result.checkpoint.productsObserved, 20);
  assert.equal(result.checkpoint.productsScanned, 20);
  assert.equal(result.complete, false);
  assert.equal(result.limited, true);
  assert.equal(result.checkpoint.terminationReason, 'limit_reached');
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
  assert.equal(reconciliations, 0);
});

test('SH-2B paused traversal resumes with only the remaining total limit', async () => {
  const firstRequests: SupplierCatalogPageRequest[] = [];
  let pauseChecks = 0;
  const partial = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, firstRequests),
    pageSize: 7,
    totalProductLimit: 20,
    requestFingerprint: 'same-request',
    syncJobId: 'same-job',
    shouldPause: () => pauseChecks++ > 0,
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });
  assert.equal(partial.paused, true);
  assert.equal(partial.checkpoint.productsObserved, 7);

  const resumedRequests: SupplierCatalogPageRequest[] = [];
  const resumed = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, resumedRequests),
    pageSize: 7,
    totalProductLimit: 20,
    requestFingerprint: 'same-request',
    syncJobId: 'same-job',
    initial: partial.checkpoint,
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });

  assert.deepEqual(resumedRequests.map((request) => request.cursor), ['7', '14']);
  assert.deepEqual(resumedRequests.map((request) => request.pageSize), [7, 6]);
  assert.equal(resumed.checkpoint.productsObserved, 20);
  assert.equal(resumed.checkpoint.resumeCount, 1);
  assert.equal(resumed.limited, true);
});

test('SH-2B a mismatched request or job scope starts from page one', async () => {
  const initial: Partial<SupplierCatalogTraversalCheckpoint> = {
    traversalId: 'old-traversal',
    cursor: '70',
    pagesProcessed: 7,
    productsScanned: 70,
    productsObserved: 70,
    productsImported: 70,
    invalidProducts: 0,
    deletionReconciliationEligible: true,
    resumeCount: 0,
    startedAt: '2026-07-01T00:00:00.000Z',
    lastCheckpointAt: '2026-07-01T00:05:00.000Z',
    lastPageFingerprint: 'old-page',
    syncMode: 'full',
    requestFingerprint: 'old-request',
    syncJobId: 'old-job',
    totalProductLimit: null,
    deltaToken: null,
    terminationReason: null,
    status: 'paused',
  };
  const requests: SupplierCatalogPageRequest[] = [];
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(1, requests),
    pageSize: 10,
    requestFingerprint: 'new-request',
    syncJobId: 'new-job',
    initial,
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });

  assert.equal(requests[0].cursor, null);
  assert.equal(result.checkpoint.productsObserved, 1);
  assert.equal(result.checkpoint.resumeCount, 0);
  assert.notEqual(result.checkpoint.traversalId, 'old-traversal');
});

test('SH-2B filtering preserves the SH-2A non-commercial sighting invariant', () => {
  const observed = product();
  const offerId = buildSupplierOfferId('source-1', observed.supplierProductId || observed.sku, observed.sku);
  const sightings = buildFilteredSupplierOfferSightings(
    'source-1',
    [observed],
    [],
    [{ id: offerId }],
    'traversal-current',
    '2026-08-01T12:00:00.000Z',
  );

  assert.deepEqual(sightings, [{
    offerId,
    data: {
      supplierCatalogTraversalId: 'traversal-current',
      supplierCatalogSeenAt: '2026-08-01T12:00:00.000Z',
    },
  }]);
  assert.deepEqual(Object.keys(sightings[0].data).sort(), [
    'supplierCatalogSeenAt',
    'supplierCatalogTraversalId',
  ]);
});
