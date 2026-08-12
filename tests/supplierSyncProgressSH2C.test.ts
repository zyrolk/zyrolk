import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  accumulateSupplierSyncAttemptProgress,
  calculateSupplierSyncJobProgress,
  normalizeSupplierSyncJobProgress,
  SupplierSyncJobRecord,
} from '../functions/src/api/suppliers/supplierSyncJobs';
import { runSupplierCatalogTraversal } from '../functions/src/scheduled/supplierCatalogTraversal';
import {
  formatSupplierSyncProgress,
  isSupplierSyncProgressDeterminate,
  SupplierSyncJobView,
} from '../src/services/supplierSyncJobs';

const start = Date.parse('2026-08-01T08:00:00.000Z');

const job = (progress: ReturnType<typeof calculateSupplierSyncJobProgress>): SupplierSyncJobView => ({
  id: 'job-1',
  state: 'running',
  trigger: 'manual',
  sourceIds: ['supplier-a'],
  createdAt: new Date(start).toISOString(),
  updatedAt: progress.updatedAt,
  startedAt: new Date(start).toISOString(),
  retryCount: 0,
  retryLimit: 5,
  resumeCount: 0,
  progress,
});

test('SH-2C uses only an exact catalog total for determinate percent and ETA', () => {
  const exact = calculateSupplierSyncJobProgress(start, {
    phase: 'catalog_traversal',
    productsDiscovered: 25,
    productsObserved: 25,
    productsScanned: 20,
    totalProducts: 100,
    totalProductsReliability: 'exact',
    basis: 'catalog_total',
    activeElapsedMs: 60_000,
  }, start + 60_000);
  assert.equal(exact.determination, 'determinate');
  assert.equal(exact.percent, 25);
  assert.equal(exact.etaMs, 180_000);
  assert.equal(isSupplierSyncProgressDeterminate(job(exact)), true);

  const reported = calculateSupplierSyncJobProgress(start, {
    phase: 'catalog_traversal',
    productsDiscovered: 25,
    productsObserved: 25,
    totalProducts: 100,
    totalProductsReliability: 'reported',
    basis: 'catalog_total',
    activeElapsedMs: 60_000,
  }, start + 60_000);
  assert.equal(reported.determination, 'indeterminate');
  assert.equal(reported.percent, 0);
  assert.equal(reported.etaMs, null);
  assert.equal(isSupplierSyncProgressDeterminate(job(reported)), false);
  assert.doesNotMatch(formatSupplierSyncProgress(job(reported)), /0%|Calculating ETA/u);
});

test('SH-2C preserves an exact future connector total while current connector totals remain reported', async () => {
  const pages = [
    { products: [{ sku: 'one' }], targetUrl: 'https://supplier.example/products', nextCursor: '1', complete: false, catalogTotal: { count: 2, reliability: 'exact' as const } },
    { products: [{ sku: 'two' }], targetUrl: 'https://supplier.example/products', nextCursor: null, complete: true, catalogTotal: { count: 2, reliability: 'exact' as const } },
  ];
  let pageIndex = 0;
  const result = await runSupplierCatalogTraversal({
    connector: {
      syncCapabilities: {
        incremental: { supported: false, mechanism: 'unsupported', deletionSemantics: 'none' },
        categoryFilter: 'server_side', subcategoryFilter: 'server_side', searchFilter: 'server_side',
      },
      fetchProductPage: async () => pages[pageIndex++],
    },
    pageSize: 1,
    deletionReconciliationEligible: false,
    processPage: async (page) => ({ productsScanned: page.products.length, productsImported: 0 }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => undefined,
  });
  assert.equal(result.checkpoint.catalogTotalProducts, 2);
  assert.equal(result.checkpoint.catalogTotalReliability, 'exact');

  const http = readFileSync('functions/src/api/suppliers/HttpSupplierConnector.ts', 'utf8');
  const a2z = readFileSync('functions/src/api/suppliers/a2z/A2ZConnectorService.ts', 'utf8');
  assert.match(http, /catalogTotal:[\s\S]*?reliability: "reported"/u);
  assert.match(a2z, /reliability: "reported" as const/u);
});

test('SH-2C source completion remains operational metadata instead of fake catalog progress', () => {
  const progress = calculateSupplierSyncJobProgress(start, {
    phase: 'catalog_traversal',
    completedSources: 1,
    totalSources: 2,
    pagesProcessed: 4,
    productsObserved: 40,
    productsScanned: 40,
    activeElapsedMs: 30_000,
  }, start + 30_000);
  assert.equal(progress.completedSources, 1);
  assert.equal(progress.totalSources, 2);
  assert.equal(progress.determination, 'indeterminate');
  assert.equal(progress.percent, 0);
  assert.equal(progress.etaMs, null);
});

test('SH-2C preserves factual counters across a durable retry attempt', () => {
  const previous = calculateSupplierSyncJobProgress(start, {
    phase: 'waiting',
    pagesProcessed: 3,
    productsDiscovered: 60,
    productsObserved: 60,
    productsScanned: 54,
    productsQueued: 8,
    productsFailed: 6,
    activeElapsedMs: 45_000,
  }, start + 90_000);
  const cumulative = accumulateSupplierSyncAttemptProgress(previous, {
    phase: 'catalog_traversal',
    pagesProcessed: 2,
    productsDiscovered: 40,
    productsObserved: 40,
    productsScanned: 35,
    productsQueued: 4,
    productsFailed: 5,
  });
  assert.equal(cumulative.pagesProcessed, 5);
  assert.equal(cumulative.productsObserved, 100);
  assert.equal(cumulative.productsScanned, 89);
  assert.equal(cumulative.productsQueued, 12);
  assert.equal(cumulative.productsFailed, 11);
});

test('SH-2C projects legacy progress safely without trusting source-count ETA', () => {
  const legacy = {
    id: 'legacy-active',
    state: 'running',
    trigger: 'manual',
    sourceIds: ['a', 'b'],
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start + 60_000).toISOString(),
    nextAttemptAt: new Date(start).toISOString(),
    retryCount: 0,
    retryLimit: 5,
    resumeCount: 0,
    requestedBy: { uid: 'admin', email: '' },
    progress: {
      phase: 'catalog_traversal', percent: 50, completedSources: 1, totalSources: 2,
      currentSourceId: 'b', pagesProcessed: 5, productsDiscovered: 50,
      productsScanned: 45, productsQueued: 4, productsFailed: 5,
      elapsedMs: 60_000, etaMs: 60_000, etaAt: new Date(start + 120_000).toISOString(),
      updatedAt: new Date(start + 60_000).toISOString(),
    },
  } as unknown as SupplierSyncJobRecord;
  const projected = normalizeSupplierSyncJobProgress(legacy, start + 60_000);
  assert.equal(projected.determination, 'indeterminate');
  assert.equal(projected.percent, 0);
  assert.equal(projected.etaMs, null);
  assert.equal(projected.productsObserved, 50);

  const completed = normalizeSupplierSyncJobProgress({ ...legacy, state: 'completed', progress: undefined } as unknown as SupplierSyncJobRecord, start + 60_000);
  assert.equal(completed.determination, 'determinate');
  assert.equal(completed.basis, 'completed');
  assert.equal(completed.percent, 100);
});

test('SH-2C serializes timer and checkpoint heartbeat persistence and renders indeterminate ARIA honestly', () => {
  const worker = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  const component = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  assert.match(worker, /let heartbeatQueue: Promise<void> = Promise\.resolve\(\)/u);
  assert.match(worker, /heartbeatQueue\.then\(\(\) => persistHeartbeat\(input\)\)/u);
  assert.match(worker, /reportProgress: reportAttemptProgress/u);
  assert.match(component, /aria-valuenow=\{isSupplierSyncProgressDeterminate\(activeSyncJob\) \? activeSyncJob\.progress\.percent : undefined\}/u);
  assert.doesNotMatch(component, /Calculating ETA/u);
});
