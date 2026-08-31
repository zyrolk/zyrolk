import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateSupplierAccountForExternalSync,
  shouldValidateExternalSourceSupplierAccount,
} from '../functions/src/api/suppliers/supplierSyncAccountGuard';

test('external sync requires an active supplier portal account', () => {
  assert.deepEqual(evaluateSupplierAccountForExternalSync('', false, null), {
    allowed: false,
    status: 'unassigned',
    message: 'Select an active Supplier Portal account before synchronizing this external source.',
  });
  assert.deepEqual(evaluateSupplierAccountForExternalSync('account-1', false, null), {
    allowed: false,
    status: 'missing',
    message: 'Supplier Portal account account-1 was not found.',
  });
  assert.deepEqual(evaluateSupplierAccountForExternalSync('account-1', true, 'pending'), {
    allowed: false,
    status: 'pending',
    message: 'Supplier Portal account account-1 is pending approval and cannot synchronize external catalogues.',
  });
  assert.deepEqual(evaluateSupplierAccountForExternalSync('account-1', true, 'disabled'), {
    allowed: false,
    status: 'disabled',
    message: 'Supplier Portal account account-1 is disabled and cannot synchronize external catalogues.',
  });
  assert.deepEqual(evaluateSupplierAccountForExternalSync('account-1', true, 'broken'), {
    allowed: false,
    status: 'malformed',
    message: 'Supplier Portal account account-1 has an invalid profile status.',
  });
  assert.deepEqual(evaluateSupplierAccountForExternalSync('account-1', true, 'active'), {
    allowed: true,
    status: 'active',
    message: '',
  });
});

test('supplier portal virtual source bypasses external account guard', () => {
  assert.equal(shouldValidateExternalSourceSupplierAccount('supplier-portal'), false);
  assert.equal(shouldValidateExternalSourceSupplierAccount('a2z-source'), true);
});

test('supplier sync enforces account guard before catalogue traversal', () => {
  const supplierSync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const syncRequest = readFileSync('functions/src/api/suppliers/supplierSyncRequest.ts', 'utf8');

  assert.match(supplierSync, /resolveSupplierAccountSyncGuard/);
  assert.match(supplierSync, /lastFailureClassification: "authorization"/);
  assert.match(supplierSync, /shouldValidateExternalSourceSupplierAccount\(source\.id\)/);
  assert.doesNotMatch(supplierSync, /supplier-portal[\s\S]*resolveSupplierAccountSyncGuard/);
  assert.match(syncRequest, /resolveSupplierAccountSyncGuard\(db, source\.supplierAccountId\)/);
});
