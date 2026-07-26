import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatSupplierSyncProgress,
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

test('Supplier Hub keeps its authenticated API callback stable across progress renders', () => {
  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.match(component, /const getSupplierApiHeaders = useCallback\(/);
  assert.match(component, /const requestSupplierApi = useCallback\(/);
  assert.match(component, /\}, \[getSupplierApiHeaders\]\);/);
  assert.match(component, /export default React\.memo\(SupplierHubFiveStars\)/);
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
