import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sanitizeSupplierSource } from '../functions/src/api/suppliers/supplierAdminConfiguration';
import { getSupplierSourceSyncIntervalMs } from '../functions/src/scheduled/supplierSync';
import { isSupplierSourceAutoSyncDue as isScheduledSupplierSourceAutoSyncDue } from '../functions/src/scheduled/supplierSyncSettings';
import { buildSupplierOnboardingSource } from '../src/services/supplierSourceOnboarding';
import { formatSupplierDuration, supplierHealthLabel } from '../src/services/supplierHubPresentation';
import { isSupplierSourceAutoSyncDue as isBrowserSupplierSourceAutoSyncDue } from '../src/services/supplierSyncSettings';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('SH-1 supports the production per-supplier manual and automatic schedules', () => {
  assert.equal(getSupplierSourceSyncIntervalMs('1 Hour'), 60 * 60 * 1_000);
  assert.equal(getSupplierSourceSyncIntervalMs('3 Hours'), 3 * 60 * 60 * 1_000);
  assert.equal(getSupplierSourceSyncIntervalMs('6 Hours'), 6 * 60 * 60 * 1_000);
  assert.equal(getSupplierSourceSyncIntervalMs('Daily'), 24 * 60 * 60 * 1_000);
  assert.equal(getSupplierSourceSyncIntervalMs('Off'), null);

  const now = Date.parse('2026-08-01T12:00:00.000Z');
  for (const isDue of [isBrowserSupplierSourceAutoSyncDue, isScheduledSupplierSourceAutoSyncDue]) {
    assert.equal(isDue('3 Hours', now - (3 * 60 * 60 * 1_000) + 1, now), false);
    assert.equal(isDue('3 Hours', now - (3 * 60 * 60 * 1_000), now), true);
  }
});

test('SH-1 validates and persists independent source schedule settings without breaking legacy schedules', () => {
  const source = buildSupplierOnboardingSource({
    id: 'a2z-secondary',
    supplierName: 'A2Z Secondary',
    supplierType: 'a2z',
    websiteUrl: 'https://supplier.example.com',
    credentialProfile: 'supplier-a',
  });
  const automatic = sanitizeSupplierSource({
    ...source,
    syncSchedule: '3 Hours',
    settings: { ...(source.settings as Record<string, unknown>), autoSync: '3 Hours' },
  });
  const legacy = sanitizeSupplierSource({
    ...source,
    settings: { ...(source.settings as Record<string, unknown>), autoSync: '15 Minutes' },
  });

  assert.equal(automatic.syncSchedule, '3 Hours');
  assert.equal(automatic.settings.autoSync, '3 Hours');
  assert.equal(legacy.settings.autoSync, '15 Minutes');
});

test('SH-1 supplier credentials remain Secret Manager references and never browser credential values', () => {
  const source = buildSupplierOnboardingSource({
    id: 'a2z-secure',
    supplierName: 'A2Z Secure',
    supplierType: 'a2z',
    websiteUrl: 'https://supplier.example.com',
    credentialProfile: 'supplier-a',
  });
  const persisted = sanitizeSupplierSource(source);

  assert.equal(persisted.authentication.mode, 'secret_manager');
  assert.ok(persisted.authentication.credentialProfile);
  assert.doesNotMatch(JSON.stringify(persisted), /"(?:username|password)"/i);
});

test('SH-1 supplier screen exposes complete management controls, status facts, and dashboard metrics', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const dashboard = projectFile('src/components/supplier-management/SupplierManagementDashboard.tsx');
  const operations = projectFile('functions/src/api/suppliers/supplierOperations.ts');

  for (const control of [
    'Supplier Name',
    'Platform',
    'Website URL',
    'Username',
    'Credential profile ID',
    'Manual Mode',
    'Auto Mode',
    'Test Connection',
    'Sync Now',
    'Edit',
    'Delete',
  ]) assert.match(hub, new RegExp(control.replace('/', '\\/')));

  for (const schedule of ['1 Hour', '3 Hours', '6 Hours', 'Daily']) assert.match(hub, new RegExp(schedule));
  for (const status of ['Last Sync', 'Next Sync', 'Last Successful Sync', 'Last Failed Sync', 'Sync Duration', 'Current Status']) {
    assert.match(hub, new RegExp(status));
  }
  for (const metric of ['Total Products', 'Pending Review', 'Approved Products', 'Updated Products', 'Removed Products', 'Failed Imports']) {
    assert.match(dashboard, new RegExp(metric));
  }

  assert.match(operations, /supplier_product_offers"\)\.count\(\)\.get\(\)/);
  assert.match(operations, /reviewStatus", "==", "approved"/);
  assert.match(operations, /comparisonStatus", "==", "SUPPLIER_OFFER_REMOVED"/);
  assert.match(hub, /action: 'disable'/);
});

test('SH-1 sync duration presentation is factual and handles missing values', () => {
  assert.equal(formatSupplierDuration(undefined), 'Not available');
  assert.equal(formatSupplierDuration(750), '750 ms');
  assert.equal(formatSupplierDuration(15_500), '15.5 sec');
  assert.equal(formatSupplierDuration(125_000), '2 min 5 sec');
  assert.equal(supplierHealthLabel({ enabled: true, connectionStatus: 'connected', lastError: 'None' }), 'Healthy');
  assert.equal(supplierHealthLabel({ enabled: true, connectionStatus: 'connected', lastError: 'Connection failed' }), 'Needs attention');
});
