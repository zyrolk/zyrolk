import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isSupplierSourceEligibleForSync,
  projectSupplierSourceForConnector,
  selectSupplierSourcesForSync,
} from '../functions/src/scheduled/supplierSync';

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

test('an explicitly requested manual source bypasses paused scheduling state', () => {
  const pausedSource = {
    ...activeManualSource,
    enabled: false,
    sourceStatus: 'inactive',
    operationalState: 'paused',
  };
  const selected = selectSupplierSourcesForSync([pausedSource, {
    ...activeManualSource,
    id: 'other-source',
  }], ['a2z-traders'], {
    autoSyncEnabled: false,
    syncInterval: 'Manual',
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: [],
  }, 'manual', Date.now());

  assert.deepEqual(selected.map((source) => source.id), ['a2z-traders']);
  assert.deepEqual(projectSupplierSourceForConnector(selected[0], 'manual'), {
    ...pausedSource,
    enabled: true,
    sourceStatus: 'active',
  });
});

test('scheduled sync retains global and per-supplier automatic timing rules without a duplicate supplier scope', () => {
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

  assert.equal(isSupplierSourceEligibleForSync({
    ...activeManualSource,
    settings: { autoSync: '1 Hour' },
  }, {
    autoSyncEnabled: true,
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: [],
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

  assert.equal(isSupplierSourceEligibleForSync({
    ...activeManualSource,
    operationalState: 'disabled',
  }, {}, 'manual', Date.now()), false);
});

test('manual and scheduled source selection accepts every registered connector type', () => {
  const restSource = {
    ...activeManualSource,
    id: 'rest-catalog',
    supplierType: 'rest',
    connectorType: 'rest',
    settings: { autoSync: '1 Hour' },
  };
  assert.equal(isSupplierSourceEligibleForSync(restSource, {}, 'manual', Date.now()), true);
  assert.equal(isSupplierSourceEligibleForSync(restSource, { autoSyncEnabled: true }, 'scheduled', Date.now()), true);

  const unsupportedSource = {
    ...activeManualSource,
    id: 'csv-catalog',
    supplierType: 'csv',
    connectorType: 'csv',
  };
  assert.equal(isSupplierSourceEligibleForSync(unsupportedSource, {}, 'manual', Date.now()), false);
});

test('scheduled sync still rejects a paused source and the worker forwards requested source IDs', () => {
  const pausedSource = {
    ...activeManualSource,
    enabled: false,
    sourceStatus: 'inactive',
    operationalState: 'paused',
    settings: { autoSync: '1 Hour' },
  };
  assert.deepEqual(selectSupplierSourcesForSync([pausedSource], ['a2z-traders'], {
    autoSyncEnabled: true,
    syncInterval: '1 Hour',
    enabledSupplierIdsConfigured: false,
    enabledSupplierIds: [],
  }, 'scheduled', Date.now()), []);

  const worker = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(worker, /runSupplierSync\(\{[\s\S]*?trigger: lease\.job\.trigger,[\s\S]*?sourceIds: lease\.job\.sourceIds/);
  assert.match(sync, /selectSupplierSourcesForSync\([\s\S]*?await loadSupplierSources\(requestedSourceIds\),[\s\S]*?requestedSourceIds,[\s\S]*?trigger/);
  assert.match(sync, /data: projectSupplierSourceForConnector\(source, trigger\)[\s\S]*?\r?\n\s*\[\],\r?\n/);
  assert.doesNotMatch(sync, /trigger === "manual" \? \[\] : settings\.enabledSupplierIds/);
  assert.doesNotMatch(sync, /settings\.websiteSyncEnabled === false/);
});
