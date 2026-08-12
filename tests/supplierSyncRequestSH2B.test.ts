import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SupplierRegistry } from '../functions/src/api/suppliers/SupplierRegistry';
import { projectSupplierSourceForAdmin } from '../functions/src/api/suppliers/supplierAdminConfiguration';
import {
  fingerprintSupplierSyncRequest,
  parseSupplierSyncRequest,
  supplierSyncRequestIsSubset,
  validateSupplierSyncRequestCapabilities,
} from '../functions/src/api/suppliers/supplierSyncRequest';

test('SH-2B API contract requires an explicit manual mode and bounds all controls', () => {
  assert.throws(
    () => parseSupplierSyncRequest({ sourceIds: ['a2z-traders'] }, { requireExplicitMode: true }),
    /mode is required/i,
  );
  assert.throws(
    () => parseSupplierSyncRequest({ mode: null }, { requireExplicitMode: true }),
    /must be full or incremental/i,
  );
  assert.throws(() => parseSupplierSyncRequest({ mode: 'full', totalProductLimit: 10_001 }), /between 1 and 10000/i);
  assert.throws(() => parseSupplierSyncRequest({ mode: 'full', pageSize: 201 }), /between 1 and 200/i);
  assert.throws(() => parseSupplierSyncRequest({ mode: 'full', filters: { search: 'x'.repeat(121) } }), /too long/i);

  assert.deepEqual(parseSupplierSyncRequest({
    mode: 'FULL',
    filters: { category: '  Mobile   Phones ', subcategory: ' Android ', search: ' Galaxy   A55 ' },
    pageSize: 25,
    totalProductLimit: 20,
  }, { requireExplicitMode: true }), {
    mode: 'full',
    filters: { category: 'Mobile Phones', subcategory: 'Android', search: 'Galaxy A55' },
    pageSize: 25,
    totalProductLimit: 20,
  });
});

test('SH-2B connector capabilities are code-owned and report A2Z honestly', () => {
  const capabilities = SupplierRegistry.getConnectorSyncCapabilities('a2z');
  assert.deepEqual(capabilities, {
    incremental: { supported: false, mechanism: 'unsupported', deletionSemantics: 'none' },
    categoryFilter: 'server_side',
    subcategoryFilter: 'server_side',
    searchFilter: 'server_side',
  });
  assert.doesNotThrow(() => validateSupplierSyncRequestCapabilities({
    mode: 'full',
    filters: { category: 'Phones', subcategory: 'Android', search: 'A55' },
  }, capabilities, 'a2z-traders'));
  assert.throws(() => validateSupplierSyncRequestCapabilities(
    { mode: 'incremental' },
    capabilities,
    'a2z-traders',
  ), /Incremental synchronization is not supported/);

  const projected = projectSupplierSourceForAdmin({
    supplierName: 'A2Z Traders',
    connectorType: 'a2z',
    enabled: true,
    websiteUrl: 'https://supplier.example',
    capabilities: ['incremental'],
  }, 'a2z-traders');
  assert.deepEqual(projected.syncCapabilities, capabilities, 'stored capability strings cannot grant native behavior');
});

test('SH-2B sync request fingerprints are deterministic and scope-sensitive', () => {
  const first = fingerprintSupplierSyncRequest({ mode: 'full', filters: { search: 'A55' }, totalProductLimit: 20 });
  assert.equal(first, fingerprintSupplierSyncRequest({ mode: 'full', filters: { search: 'A55' }, totalProductLimit: 20 }));
  assert.notEqual(first, fingerprintSupplierSyncRequest({ mode: 'full', filters: { search: 'A56' }, totalProductLimit: 20 }));
  assert.notEqual(first, fingerprintSupplierSyncRequest({ mode: 'full', filters: { search: 'A55' }, totalProductLimit: 21 }));
  assert.equal(supplierSyncRequestIsSubset({ mode: 'full' }), false);
  assert.equal(supplierSyncRequestIsSubset({ mode: 'full', filters: { category: 'Phones' } }), true);
  assert.equal(supplierSyncRequestIsSubset({ mode: 'full', totalProductLimit: 20 }), true);
  assert.equal(supplierSyncRequestIsSubset({ mode: 'incremental' }), true);
});

test('SH-2B every manual API entry point persists an explicit server-validated request', () => {
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const worker = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  const jobs = readFileSync('functions/src/api/suppliers/supplierSyncJobs.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');

  assert.match(routes, /readManualSupplierSyncRequest\(req\.body, \{ requireExplicitMode: true \}\)/);
  assert.match(routes, /readManualSupplierSyncRequest\(\{ mode: "full" \}, \{ fallbackSourceIds: \[sourceId\] \}\)/);
  assert.match(routes, /validateSupplierSyncSources\(adminDb, sourceIds, syncRequest\)/);
  assert.match(jobs, /syncRequest: input\.syncRequest/);
  assert.match(worker, /syncRequest: lease\.job\.syncRequest/);
  assert.match(sync, /supplier_sync_history[\s\S]*syncRequest/);
});
