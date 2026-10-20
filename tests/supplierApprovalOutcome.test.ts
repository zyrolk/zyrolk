import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDurablyCommittedSupplierApproval,
  isSupplierApprovalUnknownError,
  SUPPLIER_APPROVAL_UNKNOWN_MESSAGE,
  SupplierApprovalUnknownError,
  supplierApprovalOutcome,
} from '../src/services/supplierApprovalOutcome';

test('only a committed approval response is publish success', () => {
  const result = {
    success: true,
    action: 'approved',
    status: 'approved',
    publicationStatus: 'committed',
    productId: 'ZY-123',
    approvalAuditId: 'audit-123',
  };

  assert.equal(isDurablyCommittedSupplierApproval(result), true);
  assert.equal(supplierApprovalOutcome(result), 'committed');
});

test('a missing managed primary image is a failed approval, never success', () => {
  const result = {
    success: false,
    action: 'approved',
    status: 'failed',
    error: 'A valid managed primary product image is required before publishing.',
  };

  assert.equal(isDurablyCommittedSupplierApproval(result), false);
  assert.equal(supplierApprovalOutcome(result), 'failed');
  assert.match(result.error, /managed primary product image/i);
});

test('success-shaped responses without durable publication proof remain unknown', () => {
  const result = { success: true, action: 'approved', status: 'approved', productId: 'ZY-123' };

  assert.equal(isDurablyCommittedSupplierApproval(result), false);
  assert.equal(supplierApprovalOutcome(result), 'unknown');
});

test('unknown transport outcomes are explicit and are never treated as retries or success', () => {
  const error = new SupplierApprovalUnknownError(new Error('network timeout'));

  assert.equal(isSupplierApprovalUnknownError(error), true);
  assert.equal(error.message, SUPPLIER_APPROVAL_UNKNOWN_MESSAGE);
  assert.equal(supplierApprovalOutcome({ success: false, status: 'unknown' }), 'failed');
});
