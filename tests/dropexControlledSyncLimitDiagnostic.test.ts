import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { suggestSupplierCategory } from '../functions/src/api/suppliers/supplierProductMapping';
import { shouldDeferNewSupplierProductForZeroStock } from '../functions/src/scheduled/supplierSync';
import {
  createSupplierCatalogTraversalCheckpoint,
  runSupplierCatalogTraversal,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectorSyncCapabilities,
} from '../functions/src/api/suppliers/types';
import { RawA2ZProduct } from '../functions/src/api/suppliers/a2z/types';
import {
  isSupplierSyncJobActive,
  selectSupplierSyncJobForDisplay,
  type SupplierSyncJobView,
} from '../src/services/supplierSyncJobs';

const capabilities: SupplierConnectorSyncCapabilities = {
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
    title: 'Electric Knife Sharpener',
    brand: 'Generic',
    supplierCategory: 'Mobile Accessories',
    supplierSubcategory: 'Holders',
    categoryHierarchy: ['Mobile Accessories', 'Holders'],
    longDescription: 'Supplier description',
    mediaGallery: ['https://supplier.example/atf0080.jpg'],
    wholesalePrice: 1200,
    recommendedRetailPrice: 1990,
    inventoryLevel: 8,
    ...overrides,
  };
}

function pagedConnector(total: number, requests: SupplierCatalogPageRequest[]) {
  return {
    syncCapabilities: capabilities,
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

const job = (overrides: Partial<SupplierSyncJobView>): SupplierSyncJobView => ({
  id: 'job-1',
  state: 'failed',
  trigger: 'manual',
  sourceIds: ['dropex-source'],
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:05:00.000Z',
  retryCount: 0,
  retryLimit: 3,
  resumeCount: 0,
  lastFailureReason: 'Catalog traversal integrity failure after 25 scanned products.',
  progress: {
    phase: 'failed',
    percent: 100,
    completedSources: 0,
    totalSources: 1,
    currentSourceId: null,
    pagesProcessed: 5,
    productsDiscovered: 25,
    productsScanned: 25,
    productsQueued: 10,
    productsFailed: 0,
    elapsedMs: 120_000,
    etaMs: null,
    etaAt: null,
    updatedAt: '2026-09-02T00:05:00.000Z',
  },
  ...overrides,
});

test('DROPEX-LIMIT-01 one job traversal never observes more than totalProductLimit products', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, requests),
    pageSize: 5,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-single-cap',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      throw new Error('must not reconcile');
    },
  });

  assert.equal(result.limited, true);
  assert.equal(result.checkpoint.productsObserved, 5);
  assert.equal(result.checkpoint.productsScanned, 5);
  assert.equal(requests.length, 1);
});

test('DROPEX-LIMIT-02 explicit continue starts after the saved checkpoint cursor', async () => {
  const first = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 5,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-batch-1',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });
  const observed: string[] = [];
  const second = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 5,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-batch-2',
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
});

test('DROPEX-LIMIT-03 limited continuation is not implicit without catalogContinuation continue', async () => {
  const first = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 5,
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-a',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });
  const checkpoint = createSupplierCatalogTraversalCheckpoint(first.checkpoint, {
    syncJobId: 'job-b',
    totalProductLimit: 5,
    requestFingerprint: 'dropex-limit-5',
  });
  assert.equal(checkpoint.productsObserved, 0);
  assert.equal(checkpoint.cursor, null);
});

test('DROPEX-LIMIT-04 supplier sync does not auto-continue a limited checkpoint from the same job id', () => {
  const source = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(source, /syncJobId !== batchId/u);
});

test('DROPEX-LIMIT-05 zero-stock new products are deferred instead of queued for review', () => {
  assert.equal(shouldDeferNewSupplierProductForZeroStock({
    inventoryLevel: 0,
    providedFields: ['stock'],
  }, false), true);
  assert.equal(shouldDeferNewSupplierProductForZeroStock({
    inventoryLevel: 4,
    providedFields: ['stock'],
  }, false), false);
});

test('DROPEX-LIMIT-06 queued counter semantics exclude refreshed review updates in supplier sync', () => {
  const source = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(source, /queueLifecycle\.requeueForMedia/u);
  assert.match(source, /metrics\.productsUpdated/u);
});

test('DROPEX-LIMIT-07 supplier review identity remains one queue item per supplier offer identity', () => {
  const source = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(source, /planSupplierReviewQueueIds/u);
  assert.match(source, /activeReviewQueueDoc/u);
});

test('DROPEX-LIMIT-08 failed terminal sync jobs remain selectable after refresh when no active job exists', () => {
  const failed = job({ id: 'failed-job', state: 'failed' });
  const selected = selectSupplierSyncJobForDisplay([failed]);
  assert.equal(selected?.id, 'failed-job');
  assert.equal(isSupplierSyncJobActive(selected), false);
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  assert.match(hub, /selectSupplierSyncJobViews/u);
  assert.match(hub, /lastSyncJob/u);
  assert.match(hub, /currentSyncJob/u);
});

test('DROPEX-LIMIT-09 supplier category mapping falls back to supplierCategory when hierarchy is empty', () => {
  const mapping = suggestSupplierCategory({
    sourceId: 'dropex-source',
    supplierCategories: ['Kitchen Appliances'],
    productTitle: 'Electric Knife Sharpener',
    categories: [{ id: 'kitchen', name: 'Kitchen', isActive: true, subcategories: [], specificationTemplate: [] }],
    mappings: [],
  });
  assert.equal(mapping.supplierCategory, 'Kitchen Appliances');
});

test('DROPEX-LIMIT-10 limited traversal disables deletion reconciliation', async () => {
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, []),
    pageSize: 5,
    totalProductLimit: 5,
    deletionReconciliationEligible: true,
    requestFingerprint: 'dropex-limit-5',
    syncJobId: 'job-limited',
    processPage: processEntirePage,
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      throw new Error('must not reconcile');
    },
  });
  assert.equal(result.limited, true);
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
});
