import assert from 'node:assert/strict';
import test from 'node:test';
import { getSupplierSourceType, isActiveWebsiteSupplier } from '../src/services/supplierSourceUtils';

test('supplier source type supports current and legacy website records', () => {
  assert.equal(getSupplierSourceType({ id: 'current', supplierType: 'Website' }), 'website');
  assert.equal(getSupplierSourceType({ id: 'legacy', type: 'website' }), 'website');
  assert.equal(isActiveWebsiteSupplier({ id: 'legacy', type: 'website', sourceStatus: 'active' }), true);
});

test('supplier source eligibility excludes inactive and non-website sources', () => {
  assert.equal(isActiveWebsiteSupplier({ id: 'disabled', type: 'website', sourceStatus: 'inactive' }), false);
  assert.equal(isActiveWebsiteSupplier({ id: 'api', supplierType: 'api', sourceStatus: 'active' }), false);
});
