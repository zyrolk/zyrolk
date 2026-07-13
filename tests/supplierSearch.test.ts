import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSupplierSearch, normalizeSupplierSearchValue } from '../src/services/supplierSearch';

test('supplier search normalization ignores case, spaces, and hyphens', () => {
  assert.equal(normalizeSupplierSearchValue('  AbC- 12-XY '), 'abc12xy');
});

test('supplier queue search covers every supported supplier code field', () => {
  const records = [
    { supplierCode: 'SUP-001' },
    { supplierItemCode: 'ITEM 002' },
    { sku: 'SKU-003' },
    { productPayload: { supplierItemCode: 'PAY ITEM-004' } },
    { productPayload: { sku: 'PAY-SKU 005' } },
  ];

  ['sup001', 'item-002', 'sku 003', 'payitem004', 'PAY SKU-005'].forEach((query, index) => {
    assert.equal(matchesSupplierSearch(records[index], query), true);
  });
});

test('supplier queue search also matches product and supplier names', () => {
  assert.equal(matchesSupplierSearch({ productName: 'Solar Power Bank' }, 'solar-power'), true);
  assert.equal(matchesSupplierSearch({ supplierName: 'A2Z Smart Tech' }, 'a2z smart'), true);
  assert.equal(matchesSupplierSearch({ supplierCode: 'ABC-123' }, 'missing'), false);
});
