import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isSupplierSourceEligibleForSync,
  supplierSourceAutoSyncSchedule,
} from '../functions/src/scheduled/supplierSync';
import {
  supplierReviewDecisionReady,
  supplierReviewStatusLabel,
} from '../src/services/supplierHubPresentation';

const enabledSource = {
  id: 'a2z-traders',
  enabled: true,
  sourceStatus: 'active',
  supplierType: 'website',
  connectorType: 'a2z',
  settings: { autoSync: 'Off' },
};

test('manual supplier updates ignore every automatic scheduling authority', () => {
  assert.equal(isSupplierSourceEligibleForSync(enabledSource, {
    websiteSyncEnabled: false,
    autoSyncEnabled: false,
    syncInterval: 'Manual',
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: [],
  }, 'manual', Date.now()), true);
});

test('scheduled updates require the global master and the canonical per-supplier schedule', () => {
  const syncImplementation = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(syncImplementation, /trigger === "scheduled" && !isSyncDue\(settings\)/);
  assert.equal(isSupplierSourceEligibleForSync(enabledSource, { autoSyncEnabled: true }, 'scheduled', Date.now()), false);
  const scheduled = { ...enabledSource, settings: { autoSync: '1 Hour' } };
  assert.equal(isSupplierSourceEligibleForSync(scheduled, { autoSyncEnabled: true }, 'scheduled', Date.now()), true);
  assert.equal(supplierSourceAutoSyncSchedule(scheduled), '1 Hour');
  assert.equal(supplierSourceAutoSyncSchedule({ ...scheduled, settings: {}, syncSchedule: '6 Hours' }), '6 Hours');
});

test('Product Review distinguishes preparation from administrator decisions', () => {
  assert.equal(supplierReviewDecisionReady({ status: 'Pending', queueState: 'queued' }), false);
  assert.equal(supplierReviewStatusLabel({ status: 'Pending', queueState: 'queued' }), 'Preparing');
  assert.equal(supplierReviewDecisionReady({ status: 'Pending', queueState: 'review_pending' }), true);
  assert.equal(supplierReviewDecisionReady({ status: 'CONFLICT', queueState: 'conflict' }), true);
});

test('production exports cannot automatically project supplier offer changes to storefront products', () => {
  const functionsEntry = readFileSync('functions/src/index.ts', 'utf8');
  const supplierHub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  assert.doesNotMatch(functionsEntry, /reconcileSupplierOfferFailover/);
  assert.doesNotMatch(functionsEntry, /reconcileSupplierSourceOfferAvailability/);
  assert.match(supplierHub, /await loadSupplierQueueView\(\)/);
  assert.doesNotMatch(supplierHub, /Promise\.all\(\[loadSupplierQueueView\('review'\), loadSupplierQueueView\('changes'\)\]\)/);
});
