import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectorSyncCapabilities,
} from '../functions/src/api/suppliers/types';
import { RawA2ZProduct } from '../functions/src/api/suppliers/a2z/types';
import { decideSupplierQueueItem } from '../functions/src/api/suppliers/supplierApproval';
import {
  buildSupplierQueueLifecycle,
  resolveSupplierReviewQueueUpsertLifecycle,
  supplierManagedMediaMatchesSourceUrls,
  supplierReviewQueueMediaIsReady,
} from '../functions/src/scheduled/supplierReviewQueue';
import {
  createSupplierCatalogTraversalCheckpoint,
  runSupplierCatalogTraversal,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import {
  supplierReviewCanQuickApprove,
  supplierReviewCanReject,
  supplierReviewDecisionReady,
  supplierReviewIsPreparing,
} from '../src/services/supplierHubPresentation';
import { buildSupplierManualSyncRequest } from '../src/services/supplierManualSync';

const unsupportedCapabilities: SupplierConnectorSyncCapabilities = {
  incremental: { supported: false, mechanism: 'unsupported', deletionSemantics: 'none' },
  categoryFilter: 'server_side',
  subcategoryFilter: 'server_side',
  searchFilter: 'server_side',
};

function product(overrides: Partial<RawA2ZProduct> = {}): RawA2ZProduct {
  return {
    sku: 'ATF0080',
    supplierProductId: 'atf0080',
    barcode: '479000000080',
    title: 'Electric Knife Sharpener Swifty Sharp',
    brand: 'Generic',
    supplierCategory: 'Kitchen',
    supplierSubcategory: 'Tools',
    categoryHierarchy: ['Kitchen', 'Tools'],
    longDescription: 'Sharpener description',
    mediaGallery: ['https://supplier.example/atf0080.jpg'],
    wholesalePrice: 1200,
    recommendedRetailPrice: 1990,
    inventoryLevel: 8,
    ...overrides,
  };
}

function pagedConnector(total: number, requests: SupplierCatalogPageRequest[]) {
  return {
    syncCapabilities: unsupportedCapabilities,
    async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
      requests.push(structuredClone(request));
      const offset = Number(request.cursor || 0);
      const count = Math.max(0, Math.min(request.pageSize, total - offset));
      const products = Array.from({ length: count }, (_, index) => product({
        sku: `SKU-${String(offset + index).padStart(4, '0')}`,
        supplierProductId: `product-${offset + index}`,
        title: `Product ${offset + index}`,
        mediaGallery: [`https://supplier.example/product-${offset + index}.jpg`],
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

test('first limited Dropex-style batch returns products 1-5', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, requests),
    pageSize: 25,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-1',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      throw new Error('must not reconcile');
    },
  });

  assert.equal(result.limited, true);
  assert.equal(result.checkpoint.productsObserved, 5);
  assert.equal(result.checkpoint.cursor, '5');
  assert.equal(requests[0].cursor, null);
  assert.equal(requests.reduce((sum, request) => sum + request.pageSize, 0) >= 5, true);
});

test('continue-next-batch returns products 6-10, not 1-5', async () => {
  const firstRequests: SupplierCatalogPageRequest[] = [];
  const first = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, firstRequests),
    pageSize: 25,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-1',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });
  assert.equal(first.limited, true);

  const secondRequests: SupplierCatalogPageRequest[] = [];
  const observed: string[] = [];
  const second = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, secondRequests),
    pageSize: 25,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-2',
    catalogContinuation: 'continue',
    initial: first.checkpoint,
    processPage: async (page) => {
      observed.push(...page.products.map((entry) => entry.sku));
      return processEntirePage(page);
    },
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });

  assert.equal(second.limited, true);
  assert.equal(second.checkpoint.productsObserved, 10);
  assert.deepEqual(observed, ['SKU-0005', 'SKU-0006', 'SKU-0007', 'SKU-0008', 'SKU-0009']);
  assert.equal(secondRequests[0].cursor, '5');
  assert.notEqual(observed[0], 'SKU-0000');
});

test('third continuation returns the next limited batch', async () => {
  let checkpoint = (await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 10,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-1',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  })).checkpoint;

  checkpoint = (await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 10,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-2',
    catalogContinuation: 'continue',
    initial: checkpoint,
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  })).checkpoint;

  const observed: string[] = [];
  const third = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 10,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-3',
    catalogContinuation: 'continue',
    initial: checkpoint,
    processPage: async (page) => {
      observed.push(...page.products.map((entry) => entry.sku));
      return processEntirePage(page);
    },
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });

  assert.equal(third.checkpoint.productsObserved, 15);
  assert.deepEqual(observed, ['SKU-0010', 'SKU-0011', 'SKU-0012', 'SKU-0013', 'SKU-0014']);
});

test('limit-terminated traversal never performs removal reconciliation', async () => {
  let reconciled = false;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(50, []),
    pageSize: 10,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciled = true; },
  });
  assert.equal(result.limited, true);
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
  assert.equal(reconciled, false);
});

test('explicit restart-from-beginning resets traversal only when requested', () => {
  const continued = createSupplierCatalogTraversalCheckpoint({
    traversalId: 'traversal-1',
    cursor: '25',
    pagesProcessed: 3,
    productsScanned: 25,
    productsObserved: 25,
    productsObservedAtBatchStart: 20,
    productsImported: 25,
    invalidProducts: 0,
    deletionReconciliationEligible: false,
    resumeCount: 2,
    startedAt: '2026-08-01T00:00:00.000Z',
    lastCheckpointAt: '2026-08-01T00:05:00.000Z',
    syncMode: 'full',
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-old',
    totalProductLimit: 5,
    terminationReason: 'limit_reached',
    status: 'limited',
  }, {
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-new',
    totalProductLimit: 5,
    catalogContinuation: 'continue',
  });
  assert.equal(continued.cursor, '25');
  assert.equal(continued.productsObserved, 25);
  assert.equal(continued.productsObservedAtBatchStart, 25);

  const restarted = createSupplierCatalogTraversalCheckpoint({
    traversalId: 'traversal-1',
    cursor: '25',
    pagesProcessed: 3,
    productsScanned: 25,
    productsObserved: 25,
    productsImported: 25,
    invalidProducts: 0,
    deletionReconciliationEligible: false,
    resumeCount: 2,
    startedAt: '2026-08-01T00:00:00.000Z',
    lastCheckpointAt: '2026-08-01T00:05:00.000Z',
    syncMode: 'full',
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-old',
    totalProductLimit: 5,
    terminationReason: 'limit_reached',
    status: 'limited',
  }, {
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-new',
    totalProductLimit: 5,
    catalogContinuation: 'restart',
  });
  assert.equal(restarted.cursor, null);
  assert.equal(restarted.productsObserved, 0);
  assert.equal(restarted.productsObservedAtBatchStart, 0);
  assert.notEqual(restarted.traversalId, 'traversal-1');
});

test('existing managed-media-ready review does not regress to Preparing when supplier images are unchanged', () => {
  const sourceUrls = ['https://supplier.example/atf0080.jpg'];
  const managedMedia = [{
    contentHash: 'a'.repeat(64),
    firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/atf0080.jpg',
    originalSupplierUrl: sourceUrls[0],
    variants: { large: { firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/atf0080.jpg' } },
    isPrimary: true,
    sortOrder: 0,
  }];
  const lifecycle = resolveSupplierReviewQueueUpsertLifecycle({
    existing: {
      queueState: 'review_pending',
      managedMedia,
      mediaStatus: 'ready',
      queueCreatedAt: '2026-08-01T00:00:00.000Z',
    },
    sourceUrls,
    queueCreatedAt: '2026-08-02T00:00:00.000Z',
  });

  assert.equal(lifecycle.preserveReviewPending, true);
  assert.equal(lifecycle.requeueForMedia, false);
  assert.equal(lifecycle.lifecycleFields.queueState, 'review_pending');
  assert.notEqual(lifecycle.lifecycleFields.queueState, buildSupplierQueueLifecycle().queueState);
});

test('changed supplier images correctly trigger media processing', () => {
  const lifecycle = resolveSupplierReviewQueueUpsertLifecycle({
    existing: {
      queueState: 'review_pending',
      managedMedia: [{
        contentHash: 'a'.repeat(64),
        firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/atf0080.jpg',
        originalSupplierUrl: 'https://supplier.example/old.jpg',
        variants: { large: { firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/atf0080.jpg' } },
        isPrimary: true,
        sortOrder: 0,
      }],
      mediaStatus: 'ready',
    },
    sourceUrls: ['https://supplier.example/new.jpg'],
    queueCreatedAt: '2026-08-02T00:00:00.000Z',
  });

  assert.equal(lifecycle.requeueForMedia, true);
  assert.equal(lifecycle.lifecycleFields.queueState, 'queued');
});

test('approval remains blocked while required media is processing', () => {
  const preparing = {
    status: 'pending',
    queueState: 'processing',
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    managedMedia: [{
      firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/image.jpg',
      isPrimary: true,
      sortOrder: 0,
    }],
  };
  assert.equal(supplierReviewIsPreparing(preparing), true);
  assert.equal(supplierReviewCanQuickApprove(preparing), false);
  assert.equal(supplierReviewDecisionReady(preparing), false);
});

test('reject remains available while media is processing', () => {
  const preparing = {
    status: 'pending',
    queueState: 'processing',
    productValidation: { readyToPublish: false, missingFields: ['images'], errors: [] },
  };
  assert.equal(supplierReviewCanReject(preparing), true);
  assert.equal(supplierReviewCanQuickApprove(preparing), false);
});

test('manual sync request supports continue and restart continuation controls', () => {
  assert.deepEqual(buildSupplierManualSyncRequest({
    sourceId: 'dropex-source',
    mode: 'full',
    totalProductLimit: '5',
    catalogContinuation: 'continue',
  }), {
    sourceIds: ['dropex-source'],
    mode: 'full',
    totalProductLimit: 5,
    catalogContinuation: 'continue',
  });
  assert.deepEqual(buildSupplierManualSyncRequest({
    sourceId: 'dropex-source',
    mode: 'full',
    totalProductLimit: '5',
    catalogContinuation: 'restart',
  }).catalogContinuation, 'restart');
});

test('supplier managed media helpers validate reuse preconditions', () => {
  const urls = ['https://supplier.example/atf0080.jpg'];
  const assets = [{
    contentHash: 'a'.repeat(64),
    firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/atf0080.jpg',
    originalSupplierUrl: urls[0],
    variants: { large: { firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/atf0080.jpg' } },
    isPrimary: true,
    sortOrder: 0,
  }];
  assert.equal(supplierManagedMediaMatchesSourceUrls(assets, urls), true);
  assert.equal(supplierReviewQueueMediaIsReady(assets), true);
  assert.equal(supplierManagedMediaMatchesSourceUrls(assets, ['https://supplier.example/other.jpg']), false);
});

test('A2Z shared traversal continuation code remains available to limited sync', () => {
  const traversal = readFileSync('functions/src/scheduled/supplierCatalogTraversal.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(traversal, /productsObservedAtBatchStart/);
  assert.match(traversal, /catalogContinuation/);
  assert.match(sync, /catalogContinuation/);
});

test('reject approval gate is fail-closed but reject path is not blocked by preparing state', () => {
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const card = readFileSync('src/components/SupplierReviewQuickCard.tsx', 'utf8');
  assert.match(approval, /if \(\s*action === "approved"[\s\S]*not ready for an admin decision/);
  assert.match(card, /canReject/);
  assert.match(card, /Approval unavailable while media is processing/);
});

test('decideSupplierQueueItem export remains stable for emulator-critical consumers', () => {
  assert.equal(typeof decideSupplierQueueItem, 'function');
});
