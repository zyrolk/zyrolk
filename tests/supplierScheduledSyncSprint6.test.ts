import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getNextSupplierSourceSyncIso,
  getSupplierSourceSyncIntervalMs,
  SUPPLIER_SCHEDULER_SCHEDULE,
} from '../functions/src/scheduled/supplierSync';

test('Sprint 6 defaults to hourly scheduler execution and derives per-source next execution safely', () => {
  assert.equal(SUPPLIER_SCHEDULER_SCHEDULE, 'every 60 minutes');
  assert.equal(getSupplierSourceSyncIntervalMs('Off'), null);
  assert.equal(getSupplierSourceSyncIntervalMs('1 hour'), 60 * 60 * 1_000);
  assert.equal(getSupplierSourceSyncIntervalMs('daily'), 24 * 60 * 60 * 1_000);
  assert.equal(getNextSupplierSourceSyncIso('1 hour', 0), '1970-01-01T01:00:00.000Z');
  assert.equal(getNextSupplierSourceSyncIso('Off', 0), null);
});

test('Sprint 6 keeps manual and scheduled runs on one pipeline with leases, recovery, and source failure isolation', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');

  assert.match(sync, /export async function runSupplierSync/);
  assert.match(sync, /runSupplierSync\(\{ trigger: "scheduled" \}\)/);
  assert.match(routes, /runSupplierSync\(\{[\s\S]*trigger: "manual"/);
  assert.match(sync, /acquireSyncLock\(startedAt, batchId, trigger\)/);
  assert.match(sync, /recoverStaleSourceSyncLeases/);
  assert.match(sync, /clearInterruptedSourceSyncMarkers/);
  assert.match(sync, /currentlySyncing: true/);
  assert.match(sync, /lastSuccessfulSyncAt/);
  assert.match(sync, /lastFailedSyncAt/);
  assert.match(sync, /nextScheduledSyncAt/);
  assert.match(sync, /for \(const source of sources\)[\s\S]*catch \(error: any\)[\s\S]*continue;/);
  assert.match(sync, /productsDiscovered/);
  assert.match(sync, /productsSkipped/);
  assert.match(sync, /productsFailed/);
  assert.match(sync, /retryCount/);
  assert.match(sync, /classifySupplierQueueFailure/);
  assert.match(sync, /lastFailureClassification/);
  assert.match(sync, /existingQueueIds\.has\(queueItemId\) \|\| queuedSupplierCodes\.has/);
});

test('Sprint 6 exposes administrator-only scheduler observability without changing the Supplier Hub UI', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');

  assert.match(sync, /getSupplierSyncSchedulerStatus/);
  assert.match(sync, /activeSyncCount/);
  assert.match(sync, /activeSourceCount/);
  assert.match(sync, /nextPlannedExecution/);
  assert.match(routes, /\/api\/supplier-sync\/status", requireSupplierHubAdmin/);
  assert.match(routes, /getSupplierSyncSchedulerStatus/);
});
