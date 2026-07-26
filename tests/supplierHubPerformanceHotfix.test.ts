import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatSupplierSyncProgress,
  selectSupplierSyncJobForDisplay,
  SupplierSyncJobView,
} from '../src/services/supplierSyncJobs';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const buildJob = (overrides: Partial<SupplierSyncJobView> = {}): SupplierSyncJobView => ({
  id: 'job-1',
  state: 'running',
  trigger: 'manual',
  sourceIds: ['supplier-a'],
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:05.000Z',
  retryCount: 0,
  retryLimit: 5,
  resumeCount: 0,
  progress: {
    phase: 'catalog_traversal',
    percent: 0,
    completedSources: 0,
    totalSources: 1,
    currentSourceId: 'supplier-a',
    pagesProcessed: 5,
    productsDiscovered: 40,
    productsScanned: 40,
    productsQueued: 8,
    productsFailed: 0,
    elapsedMs: 5_000,
    etaMs: null,
    etaAt: null,
    updatedAt: '2026-07-26T00:00:05.000Z',
  },
  ...overrides,
});

test('active single-source traversal reports indeterminate progress instead of a false zero percent', () => {
  const summary = formatSupplierSyncProgress(buildJob());
  assert.match(summary, /Running · In progress · 40 scanned/);
  assert.doesNotMatch(summary, /0%/);

  const completed = formatSupplierSyncProgress(buildJob({
    state: 'completed',
    progress: { ...buildJob().progress, phase: 'completed', percent: 100, completedSources: 1 },
  }));
  assert.equal(completed, 'Completed · 40 scanned · 8 queued');
});

test('job selection follows the worker state instead of a newer waiting job', () => {
  const running = buildJob({
    id: 'running-job',
    state: 'running',
    createdAt: '2026-07-26T00:00:00.000Z',
    startedAt: '2026-07-26T00:00:01.000Z',
  });
  const newerWaiting = buildJob({
    id: 'waiting-job',
    state: 'waiting',
    createdAt: '2026-07-26T00:01:00.000Z',
    nextAttemptAt: '2026-07-26T00:01:15.000Z',
    progress: { ...buildJob().progress, phase: 'waiting', pagesProcessed: 0, productsScanned: 0 },
  });

  assert.equal(selectSupplierSyncJobForDisplay([newerWaiting, running])?.id, 'running-job');
});

test('job selection hands off to queued work after the tracked job completes', () => {
  const completed = buildJob({
    id: 'completed-job',
    state: 'completed',
    createdAt: '2026-07-26T00:00:00.000Z',
    progress: { ...buildJob().progress, phase: 'completed', percent: 100 },
  });
  const queued = buildJob({
    id: 'queued-job',
    state: 'waiting',
    createdAt: '2026-07-26T00:01:00.000Z',
    nextAttemptAt: '2026-07-26T00:01:15.000Z',
  });

  assert.equal(selectSupplierSyncJobForDisplay([completed, queued])?.id, 'queued-job');
});

test('Supplier Hub keeps its authenticated API callback stable across progress renders', () => {
  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.match(component, /const getSupplierApiHeaders = useCallback\(/);
  assert.match(component, /const requestSupplierApi = useCallback\(/);
  assert.match(component, /\}, \[getSupplierApiHeaders\]\);/);
  assert.match(component, /export default React\.memo\(SupplierHubFiveStars\)/);
});

test('Supplier Hub prevents another source sync while an active job is being tracked', () => {
  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.match(component, /syncStartInFlightRef\.current \|\| isSupplierSyncJobActive\(currentJob\)/);
  assert.match(component, /const currentJob = activeSyncJobRef\.current/);
  assert.match(component, /disabled=\{isSyncing \|\| syncingSourceId !== null \|\| testingSourceId !== null\}/);
  assert.match(component, /supplier-sync\/jobs\?limit=20/);
});

test('operations sync delegates to the canonical parent job state and shared duplicate guard', () => {
  const parent = projectFile('src/components/SupplierHubFiveStars.tsx');
  const operations = projectFile('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  const actionStart = operations.indexOf('const runSupplierAction');
  const actionEnd = operations.indexOf('const runQueueAction', actionStart);

  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  assert.match(parent, /onSyncSupplier=\{handleSyncSupplier\}/);
  assert.match(parent, /syncInProgress=\{isSyncing\}/);
  assert.match(parent, /const handleSyncSupplier = useCallback/);
  assert.match(parent, /applyActiveSyncJob\(result\.job\)/);
  assert.match(parent, /const applyActiveSyncJob = useCallback[\s\S]*setIsSyncing\(active\)/);
  assert.match(operations.slice(actionStart, actionEnd), /action === 'sync' \|\| action === 'retry'/);
  assert.match(operations.slice(actionStart, actionEnd), /await onSyncSupplier\(\[supplierId\]\)/);
  assert.match(operations, /disabled=\{syncInProgress \|\| Boolean\(actionId\)\}/);
});

test('operations refresh does not duplicate queue requests or rerender on unchanged parent props', () => {
  const component = projectFile('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  const loadAllStart = component.indexOf('const loadAll = useCallback');
  const loadAllEnd = component.indexOf('useEffect(() =>', loadAllStart);
  assert.ok(loadAllStart >= 0 && loadAllEnd > loadAllStart);
  assert.doesNotMatch(component.slice(loadAllStart, loadAllEnd), /loadQueue\(false\)/);
  assert.match(component, /window\.setInterval\(\(\) => void loadQueue\(false\)/);
  assert.match(component, /export default React\.memo\(SupplierOperationsDashboard\)/);
});
