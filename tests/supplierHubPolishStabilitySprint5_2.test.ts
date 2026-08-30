import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatSupplierTimestamp,
  supplierAdministratorLabel,
  supplierBusinessErrorMessage,
} from '../src/services/supplierHubPresentation';

const supplierHubSource = readFileSync(
  new URL('../src/components/SupplierHubFiveStars.tsx', import.meta.url),
  'utf8',
);

test('supplier timestamps support Firestore Timestamp, Date, ISO, and missing values', () => {
  const expected = new Date('2026-07-28T08:30:00.000Z').toLocaleString();

  assert.equal(formatSupplierTimestamp({ toDate: () => new Date('2026-07-28T08:30:00.000Z') }), expected);
  assert.equal(formatSupplierTimestamp(new Date('2026-07-28T08:30:00.000Z')), expected);
  assert.equal(formatSupplierTimestamp('2026-07-28T08:30:00.000Z'), expected);
  assert.equal(formatSupplierTimestamp(undefined), 'Not updated yet');
  assert.equal(formatSupplierTimestamp(null), 'Not updated yet');
  assert.equal(formatSupplierTimestamp('not-a-date'), 'Not updated yet');
  assert.doesNotMatch(formatSupplierTimestamp('not-a-date'), /Invalid Date/i);
});

test('administrator presentation never exposes a Firebase UID', () => {
  const currentAdmin = { uid: 'firebase-uid-123', displayName: 'Store Owner', email: 'owner@zyro.lk' };

  assert.equal(supplierAdministratorLabel('firebase-uid-123', currentAdmin), 'Store Owner');
  assert.equal(supplierAdministratorLabel('someone@zyro.lk', currentAdmin), 'someone@zyro.lk');
  assert.equal(supplierAdministratorLabel({ displayName: 'Catalog Admin', email: 'admin@zyro.lk' }), 'Catalog Admin');
  assert.equal(supplierAdministratorLabel('unrecognized-firebase-uid', currentAdmin), 'Administrator');
});

test('empty Supplier Hub views use business empty states while real App Check failures remain visible', () => {
  for (const copy of [
    'No connected sources yet',
    'Connect an external supplier integration when you are ready to sync an API or catalog feed.',
    'No products pending review',
    'Supplier product submissions and synced catalogue changes will appear here.',
    'No supplier activity yet.',
    'Supplier account, product review, and synchronization activity will appear here.',
    'Connect a supplier to configure category mapping.',
    'No supplier restrictions configured.',
  ]) {
    assert.match(supplierHubSource, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(supplierHubSource, /supplierSourcesLoaded && supplierSources\.length === 0/);
  assert.equal(
    supplierBusinessErrorMessage(new Error('App Check token verification failed')),
    'Your secure session could not be verified. Refresh the page and try again.',
  );
});

test('mobile Supplier Hub navigation and review filters wrap without horizontal tab scrolling', () => {
  assert.match(supplierHubSource, /flex w-full flex-wrap items-center gap-1\.5/);
  assert.match(supplierHubSource, /className="mt-4 flex flex-wrap gap-2 pb-1" role="tablist"/);
  assert.match(supplierHubSource, /className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto"/);
});
