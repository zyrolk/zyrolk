import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierManualSyncRequest,
  supplierSyncFilterExecutionLabel,
  supplierSyncFilterIsSupported,
} from '../src/services/supplierManualSync';

const serverSideCapabilities = {
  incremental: {
    supported: false,
    mechanism: 'unsupported' as const,
    deletionSemantics: 'none' as const,
  },
  categoryFilter: 'server_side' as const,
  subcategoryFilter: 'server_side' as const,
  searchFilter: 'server_side' as const,
};

test('SH-2B manual initial synchronization sends an explicit full mode', () => {
  assert.deepEqual(buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders',
    mode: 'full',
    capabilities: serverSideCapabilities,
  }), {
    sourceIds: ['a2z-traders'],
    mode: 'full',
  });
});

test('SH-2B rejects incremental mode when the projected connector capability is unsupported', () => {
  assert.throws(() => buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders',
    mode: 'incremental',
    capabilities: serverSideCapabilities,
  }), /Incremental Sync is not supported/);

  assert.throws(() => buildSupplierManualSyncRequest({
    sourceId: 'legacy-source-without-capabilities',
    mode: 'incremental',
  }), /Incremental Sync is not supported/);
});

test('SH-2B includes deterministic server-side category, subcategory, and search filters', () => {
  assert.deepEqual(buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders',
    mode: 'full',
    category: ' Electronics ',
    subcategory: ' Mobile Phones ',
    search: ' Samsung A55 ',
    capabilities: serverSideCapabilities,
  }), {
    sourceIds: ['a2z-traders'],
    mode: 'full',
    filters: {
      category: 'Electronics',
      subcategory: 'Mobile Phones',
      search: 'Samsung A55',
    },
  });
  assert.equal(supplierSyncFilterExecutionLabel('server_side'), 'Applied by Zyro after retrieval');
});

test('SH-2B omits unsupported filters and fails closed when capability projection is absent', () => {
  const unsupported = buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders',
    mode: 'full',
    category: 'Electronics',
    subcategory: 'Phones',
    search: 'A55',
    capabilities: {
      categoryFilter: 'unsupported',
      subcategoryFilter: 'unsupported',
      searchFilter: 'unsupported',
    },
  });
  assert.equal(Object.hasOwn(unsupported, 'filters'), false);

  const missing = buildSupplierManualSyncRequest({
    sourceId: 'legacy-source',
    mode: 'full',
    category: 'Electronics',
    search: 'A55',
  });
  assert.equal(Object.hasOwn(missing, 'filters'), false);
  assert.equal(supplierSyncFilterIsSupported(undefined), false);
  assert.equal(supplierSyncFilterIsSupported('unsupported'), false);
  assert.equal(supplierSyncFilterExecutionLabel(undefined), 'Unsupported');
});

test('SH-2B validates the traversal-wide total product limit independently', () => {
  assert.equal(buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders', mode: 'full', totalProductLimit: '1', capabilities: serverSideCapabilities,
  }).totalProductLimit, 1);
  assert.equal(buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders', mode: 'full', totalProductLimit: 10_000, capabilities: serverSideCapabilities,
  }).totalProductLimit, 10_000);
  assert.equal(Object.hasOwn(buildSupplierManualSyncRequest({
    sourceId: 'a2z-traders', mode: 'full', totalProductLimit: '', capabilities: serverSideCapabilities,
  }), 'totalProductLimit'), false);

  for (const invalid of [0, -1, 1.5, 10_001, 'invalid']) {
    assert.throws(() => buildSupplierManualSyncRequest({
      sourceId: 'a2z-traders', mode: 'full', totalProductLimit: invalid, capabilities: serverSideCapabilities,
    }), /Product count limit must be a whole number from 1 to 10,000/);
  }
});

test('SH-2B Supplier Hub wiring uses the capability-driven dialog and explicit request contract', () => {
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const dialog = readFileSync('src/components/supplier-management/SupplierManualSyncDialog.tsx', 'utf8');
  const requestBuilder = readFileSync('src/services/supplierManualSync.ts', 'utf8');

  assert.match(hub, /setManualSyncSource\(source\)/);
  assert.doesNotMatch(hub, /runManualSupplierSync\(\{ sourceIds: \[id\], mode: 'full' \}\)/);
  assert.match(hub, /postSupplierApi\('\/api\/supplier-sync', \{ \.\.\.request \}\)/);
  assert.match(hub, /<SupplierManualSyncDialog/);
  assert.match(hub, /isInitialSync=\{!supplierHasCompletedInitialSync\(manualSyncSource\)\}/);
  assert.match(dialog, /source\.syncCapabilities \|\| \{\}/);
  assert.match(dialog, /supportsIncremental \?/);
  assert.match(dialog, /required for first sync/);
  assert.match(requestBuilder, /Applied by Zyro after retrieval/);
  assert.match(dialog, /is not the catalog fetch page size/);
});
