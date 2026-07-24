import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierHealth,
  detectSupplierProductConflicts,
  resolveSupplierPriority,
} from '../functions/src/api/suppliers/multiSupplier';

test('Sprint 7 resolves multiple supplier offers deterministically by descending priority', () => {
  const supplierA = { supplierId: 'supplier-a', sourceId: 'supplier-a', priority: 100 };
  const supplierB = { supplierId: 'supplier-b', sourceId: 'supplier-b', priority: 80 };
  assert.equal(resolveSupplierPriority(supplierA, supplierB).sourceId, 'supplier-a');
  assert.equal(resolveSupplierPriority({ ...supplierA, priority: 80 }, supplierB).sourceId, 'supplier-a');
});

test('Sprint 7 detects duplicate SKU, barcode, and supplier-product conflicts without fabricating a winner', () => {
  const conflicts = detectSupplierProductConflicts([
    { supplierId: 'a', sourceId: 'a', priority: 100, sku: 'SKU-1', barcode: '123' },
    { supplierId: 'b', sourceId: 'b', priority: 80, sku: 'SKU-1', barcode: '456' },
    { supplierId: 'c', sourceId: 'c', priority: 70, sku: 'SKU-2', barcode: '123' },
    { supplierId: 'a', sourceId: 'a', priority: 100, sku: 'SKU-3', supplierProductKey: 'a:SKU-1' },
  ]);
  assert.deepEqual(conflicts.map((conflict) => conflict.reason).sort(), ['duplicate_barcode', 'duplicate_sku', 'duplicate_supplier_product']);
  assert.equal(conflicts.find((conflict) => conflict.reason === 'duplicate_sku')?.winner.sourceId, 'a');
});

test('Sprint 7 calculates factual per-supplier availability, success rate, failure rate, and latency', () => {
  const success = buildSupplierHealth({}, 'success', 120, '2026-07-20T00:00:00.000Z');
  assert.equal(success.availability, 'available');
  assert.equal(success.successRate, 100);
  assert.equal(success.failureRate, 0);
  const failure = buildSupplierHealth(success, 'failure', 280, '2026-07-20T01:00:00.000Z');
  assert.equal(failure.availability, 'unavailable');
  assert.equal(failure.successRate, 50);
  assert.equal(failure.failureRate, 50);
  assert.equal(failure.averageLatencyMs, 200);
});

test('Sprint 7 registry, source leases, conflicts, health, and scheduler retain the existing queue workflow', () => {
  const registry = readFileSync('functions/src/api/suppliers/SupplierRegistry.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const rules = readFileSync('firestore.rules', 'utf8');
  const types = readFileSync('functions/src/api/suppliers/types.ts', 'utf8');

  assert.match(registry, /registerConnectorFactory/);
  assert.match(registry, /supportedConnectorTypes/);
  assert.match(registry, /createRegistryRecord/);
  assert.match(registry, /connectorType/);
  assert.match(registry, /right\.priority - left\.priority/);
  assert.match(types, /supplierId/);
  assert.match(types, /currency/);
  assert.match(types, /timezone/);
  assert.match(types, /authentication/);
  assert.match(types, /capabilities/);
  assert.match(sync, /source-\$\{source\.id\}/);
  assert.match(sync, /supplier_product_conflicts/);
  assert.match(sync, /resolveSupplierPriority/);
  assert.match(sync, /syncHealth/);
  assert.match(sync, /syncMetrics/);
  assert.match(sync, /source\.syncMetrics\?\.retries/);
  assert.match(sync, /runSupplierSync/);
  assert.match(rules, /match \/supplier_product_conflicts\/\{docId\}[\s\S]*allow create, update, delete: if false;/);
});
