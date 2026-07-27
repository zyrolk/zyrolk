import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupplierSourceEligibleForSync } from '../functions/src/scheduled/supplierSync';

const activeManualSource = {
  id: 'a2z-traders',
  enabled: true,
  sourceStatus: 'active',
  supplierType: 'website',
  connectorType: 'a2z',
  settings: { autoSync: 'Off' },
};

test('manual sync ignores automatic schedule timing and scheduled supplier scope', () => {
  assert.equal(isSupplierSourceEligibleForSync(activeManualSource, {
    autoSyncEnabled: false,
    syncInterval: 'Manual',
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: [],
  }, 'manual', Date.now()), true);
});

test('scheduled sync retains automatic timing and explicit source scope rules', () => {
  assert.equal(isSupplierSourceEligibleForSync(activeManualSource, {
    autoSyncEnabled: true,
    syncInterval: '1 Hour',
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: [],
  }, 'scheduled', Date.now()), false);

  assert.equal(isSupplierSourceEligibleForSync({
    ...activeManualSource,
    settings: { autoSync: '1 Hour' },
  }, {
    autoSyncEnabled: true,
    syncInterval: '1 Hour',
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: ['a2z-traders'],
  }, 'scheduled', Date.now()), true);
});

test('manual sync still rejects administratively disabled or inactive sources', () => {
  assert.equal(isSupplierSourceEligibleForSync({
    ...activeManualSource,
    enabled: false,
  }, {}, 'manual', Date.now()), false);

  assert.equal(isSupplierSourceEligibleForSync({
    ...activeManualSource,
    sourceStatus: 'inactive',
  }, {}, 'manual', Date.now()), false);
});
