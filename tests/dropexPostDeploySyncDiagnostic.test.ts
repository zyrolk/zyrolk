import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestSupplierCategory } from '../functions/src/api/suppliers/supplierProductMapping';
import {
  createSupplierCatalogTraversalCheckpoint,
  runSupplierCatalogTraversal,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import {
  isSupplierConnectionClassifiedFailure,
  isSupplierSourceTerminallySuccessfulForJob,
  partitionSupplierSourcesForSyncJob,
  resolveSupplierSyncRunStatusForZeroScan,
  shouldDeferNewSupplierProductForZeroStock,
} from '../functions/src/scheduled/supplierSync';
import {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectorSyncCapabilities,
} from '../functions/src/api/suppliers/types';
import { RawA2ZProduct } from '../functions/src/api/suppliers/a2z/types';
import { isSupplierCatalogContinuationResumable } from '../src/services/supplierManualSync';
import {
  supplierConnectionPresentation,
  supplierReviewSpecificationsRequired,
} from '../src/services/supplierHubPresentation';
import {
  isSupplierSyncJobActive,
  isSupplierSyncJobTerminal,
  selectCurrentSupplierSyncJob,
  selectLastTerminalSupplierSyncJob,
  selectSupplierSyncJobForDisplay,
  selectSupplierSyncJobViews,
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

const job = (overrides: Partial<SupplierSyncJobView>): SupplierSyncJobView => ({
  id: 'job-1',
  state: 'failed',
  trigger: 'manual',
  sourceIds: ['dropex'],
  createdAt: '2026-09-02T06:00:00.000Z',
  updatedAt: '2026-09-02T06:02:00.000Z',
  retryCount: 0,
  retryLimit: 3,
  resumeCount: 0,
  lastFailureReason: 'Processing failed',
  progress: {
    phase: 'failed',
    percent: 100,
    completedSources: 0,
    totalSources: 1,
    currentSourceId: 'dropex',
    pagesProcessed: 5,
    productsDiscovered: 25,
    productsScanned: 25,
    productsQueued: 10,
    productsFailed: 0,
    elapsedMs: 120_000,
    etaMs: null,
    etaAt: null,
    updatedAt: '2026-09-02T06:02:00.000Z',
  },
  ...overrides,
});

test('POST-DEPLOY-01 failed job does not mark source terminal for checkpoint reuse on retry', () => {
  const source = {
    catalogSync: {
      syncJobId: 'failed-job',
      status: 'in_progress' as const,
      cursor: 'page-5',
      terminationReason: null,
    },
  };
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(source, 'failed-job'), false);
  assert.equal(partitionSupplierSourcesForSyncJob([source], 'failed-job').pending.length, 1);
});

test('POST-DEPLOY-02 limited checkpoint remains resumable but completed catalogue does not', () => {
  assert.equal(isSupplierCatalogContinuationResumable({
    status: 'limited',
    terminationReason: 'limit_reached',
    cursor: '25',
  }), true);
  assert.equal(isSupplierCatalogContinuationResumable({
    status: 'completed',
    terminationReason: 'catalog_complete',
    cursor: null,
  }), false);
  assert.equal(isSupplierCatalogContinuationResumable({
    status: 'in_progress',
    terminationReason: null,
    cursor: '15',
  }), false);
});

test('POST-DEPLOY-03 manual zero-scan success becomes partial', () => {
  assert.equal(
    resolveSupplierSyncRunStatusForZeroScan('manual', 'Success', { productsScanned: 0, productsQueued: 0 }, { mode: 'full', totalProductLimit: 5 }),
    'Partial',
  );
  assert.equal(
    resolveSupplierSyncRunStatusForZeroScan('scheduled', 'Success', { productsScanned: 0, productsQueued: 0 }, { mode: 'full' }),
    'Success',
  );
});

test('POST-DEPLOY-04 current and last terminal jobs are selected distinctly', () => {
  const failed = job({ id: 'failed-job', state: 'failed', createdAt: '2026-09-02T06:00:00.000Z' });
  const running = job({
    id: 'running-job',
    state: 'running',
    createdAt: '2026-09-02T06:05:00.000Z',
    progress: {
      ...job({}).progress,
      phase: 'catalog_traversal',
      productsScanned: 15,
      productsQueued: 4,
      percent: 40,
    },
  });
  const views = selectSupplierSyncJobViews([failed, running]);
  assert.equal(views.current?.id, 'running-job');
  assert.equal(views.last?.id, 'failed-job');
  assert.equal(selectSupplierSyncJobForDisplay([failed, running])?.id, 'running-job');
});

test('POST-DEPLOY-05 refresh rehydrates last terminal when no active job exists', () => {
  const completed = job({ id: 'completed-job', state: 'completed', progress: { ...job({}).progress, productsScanned: 0, productsQueued: 0 } });
  const views = selectSupplierSyncJobViews([completed]);
  assert.equal(views.current, null);
  assert.equal(views.last?.id, 'completed-job');
  assert.equal(selectSupplierSyncJobForDisplay([completed])?.id, 'completed-job');
});

test('POST-DEPLOY-06 sync validation failure is not a connection problem', () => {
  const presentation = supplierConnectionPresentation({
    connectionStatus: 'Failed',
    lastFailureClassification: 'validation',
    enabled: true,
  });
  assert.equal(presentation.label, 'Connected');
  assert.equal(isSupplierConnectionClassifiedFailure('validation'), false);
  assert.equal(isSupplierConnectionClassifiedFailure('connector'), true);
});

test('POST-DEPLOY-07 supplier category survives Dropex normalization path', () => {
  const suggestion = suggestSupplierCategory({
    sourceId: 'dropex-source',
    supplierCategories: ['Mobile Accessories', 'Holders'],
    productTitle: 'Electric Knife Sharpener',
    categories: [{ id: 'mobile', name: 'Mobile Accessories', isActive: true, subcategories: [], specificationTemplate: [] }],
    mappings: [],
  });
  assert.equal(suggestion.supplierCategory, 'Mobile Accessories');
});

test('POST-DEPLOY-08 old observation without category metadata stays backward compatible', () => {
  const required = supplierReviewSpecificationsRequired(
    { productValidation: { errors: [{ field: 'brand', code: 'missing_brand', message: 'Missing brand' }] } },
    [],
    '',
  );
  assert.equal(required, false);
});

test('POST-DEPLOY-09 zero specs and not required is non-blocking', () => {
  const required = supplierReviewSpecificationsRequired({ productValidation: {} }, [], '');
  assert.equal(required, false);
});

test('POST-DEPLOY-10 zero specs and required fails checklist semantics', () => {
  const required = supplierReviewSpecificationsRequired(
    { productValidation: { missingFields: ['specifications'] } },
    [{ id: 'cat-1', specificationTemplate: [{ required: true }] }],
    'cat-1',
  );
  assert.equal(required, true);
});

test('POST-DEPLOY-11 totalProductLimit=5 scans at most five products', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  let checkpoint = createSupplierCatalogTraversalCheckpoint({}, {
    syncJobId: 'limit-job',
    requestFingerprint: 'fp',
    totalProductLimit: 5,
    catalogContinuation: undefined,
  });
  const connector = {
    syncCapabilities: capabilities,
    async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
      requests.push(structuredClone(request));
      const offset = Number(request.cursor || 0);
      const count = Math.min(request.pageSize, 100 - offset);
      const products = Array.from({ length: count }, (_, index) => product({
        sku: `SKU-${offset + index}`,
        supplierProductId: `product-${offset + index}`,
      }));
      const nextOffset = offset + products.length;
      return {
        products,
        targetUrl: 'https://supplier.example/catalog',
        complete: nextOffset >= 100,
        nextCursor: nextOffset >= 100 ? null : String(nextOffset),
      };
    },
  };
  const result = await runSupplierCatalogTraversal({
    connector,
    pageSize: 100,
    syncMode: 'full',
    filters: {},
    totalProductLimit: 5,
    requestFingerprint: 'fp',
    syncJobId: 'limit-job',
    initial: checkpoint,
    persistCheckpoint: async (next) => { checkpoint = next; },
    reconcileDeletedProducts: async () => undefined,
    processPage: async (page) => ({ productsScanned: page.products.length, productsImported: page.products.length }),
  });
  assert.equal(result.limited, true);
  assert.equal(checkpoint.productsObserved, 5);
  assert.equal(requests.length, 1);
});

test('POST-DEPLOY-12 zero-stock deferral remains intact', () => {
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: ['stock'] }, false), true);
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 4, providedFields: ['stock'] }, false), false);
});

test('POST-DEPLOY-13 terminal job helpers classify active vs terminal states', () => {
  assert.equal(isSupplierSyncJobActive(job({ state: 'running' })), true);
  assert.equal(isSupplierSyncJobTerminal(job({ state: 'failed' })), true);
  assert.equal(selectCurrentSupplierSyncJob([job({ state: 'completed' }), job({ state: 'running', id: 'active' })])?.id, 'active');
  assert.equal(selectLastTerminalSupplierSyncJob([job({ state: 'failed', id: 'old' }), job({ state: 'completed', id: 'new', createdAt: '2026-09-02T07:00:00.000Z' })])?.id, 'new');
});
