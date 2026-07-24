import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildSupplierQueueLifecycle, canLeaseSupplierQueueItem } from '../functions/src/scheduled/supplierReviewQueue';

test('Sprint 9 removes Supplier Hub catalog and queue collection scans in favour of bounded lookups', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const registry = readFileSync('functions/src/api/suppliers/SupplierRegistry.ts', 'utf8');
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');

  assert.match(sync, /loadExistingProductsForSupplierBatch/);
  assert.match(sync, /where\("supplierItemCode", "in", codes\)/);
  assert.match(sync, /loadSupplierQueueCandidates/);
  assert.match(sync, /orderBy\(FieldPath\.documentId\(\)\)\.limit\(100\)/);
  assert.doesNotMatch(sync, /collection\("products"\)\.get\(\)/);
  assert.doesNotMatch(sync, /collection\(PRODUCT_PRIVATE_COLLECTION\)\.get\(\)/);
  assert.match(registry, /createConnectorsForSources/);
  assert.match(portal, /readPageSize/);
  assert.match(portal, /applyDocumentCursor/);
  assert.doesNotMatch(portal, /limit\(500\)|limit\(200\)/);
});

test('Sprint 9 processes due retries in stable time order and keeps queue work separate from synchronization', () => {
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const worker = readFileSync('functions/src/scheduled/supplierQueueWorker.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');

  assert.match(queue, /where\("nextRetryAt", "<=", nowIso\)/);
  assert.match(queue, /orderBy\("nextRetryAt", "asc"\)/);
  assert.match(queue, /orderBy\("queueCreatedAt", "asc"\)/);
  assert.match(worker, /processDueSupplierReviewQueueItems/);
  assert.match(worker, /recoverExpiredSupplierReviewQueueLeases/);
  assert.doesNotMatch(sync, /processDueSupplierReviewQueueItems/);
  const now = Date.now();
  assert.equal(canLeaseSupplierQueueItem({ ...buildSupplierQueueLifecycle(new Date(now - 2_000).toISOString()), nextRetryAt: new Date(now - 1_000).toISOString() }, now), true);
  assert.equal(canLeaseSupplierQueueItem({ ...buildSupplierQueueLifecycle(new Date(now - 2_000).toISOString()), nextRetryAt: new Date(now + 1_000).toISOString() }, now), false);
});

test('Sprint 9 persists queue backlog metrics through aggregation-backed bounded reads and deployable indexes', () => {
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const indexes = readFileSync('firestore.indexes.json', 'utf8');
  assert.match(queue, /queue\.count\(\)\.get\(\)/);
  assert.match(queue, /retryBacklog/);
  assert.match(queue, /oldestQueueAgeMs/);
  assert.match(queue, /averageProcessingLatencyMs/);
  assert.match(indexes, /"supplier_review_queue"/);
  assert.match(indexes, /"nextRetryAt"/);
  assert.match(indexes, /"leaseExpiresAt"/);
});
