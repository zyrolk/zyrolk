import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSupplierCategory,
  supplierCategoryMappingUiKey,
} from '../src/services/supplierCategoryMapping';

test('saved API mapping and reloaded punctuation-heavy option use the same key', () => {
  const rawCategory = "Men's Trimmers, Clippers & Cutters";
  const serverNormalizedCategory = 'men s trimmers clippers cutters';
  const optionKey = supplierCategoryMappingUiKey('dropex', rawCategory);
  const reloadedMappingKey = supplierCategoryMappingUiKey('dropex', serverNormalizedCategory);
  const drafts = {
    [reloadedMappingKey]: { targetCategoryId: 'health-beauty', targetSubcategoryId: '' },
  };

  assert.equal(normalizeSupplierCategory(rawCategory), serverNormalizedCategory);
  assert.equal(optionKey, reloadedMappingKey);
  assert.equal(drafts[optionKey]?.targetCategoryId, 'health-beauty');
});

test('ampersand and ordinary supplier categories preserve stable mapping keys', () => {
  const cases = [
    ['Health & Beauty', 'health beauty'],
    ['Kitchen Appliances', 'kitchen appliances'],
    ["Men's Fashion", 'men s fashion'],
    ['Mobile Accessories', 'mobile accessories'],
    ['OUT DOOR PARTY', 'out door party'],
  ] as const;

  for (const [raw, normalized] of cases) {
    assert.equal(normalizeSupplierCategory(raw), normalized);
    assert.equal(
      supplierCategoryMappingUiKey('dropex', raw),
      supplierCategoryMappingUiKey('dropex', normalized),
    );
  }
});

test('unmapped categories remain unselected and parent/child bindings stay distinct', () => {
  const mappedKey = supplierCategoryMappingUiKey('dropex', 'Health & Beauty');
  const unmappedKey = supplierCategoryMappingUiKey('dropex', 'Unmapped Category');
  const childNameKey = supplierCategoryMappingUiKey('dropex', 'Health & Beauty', 'Hair Care');
  const childIdKey = supplierCategoryMappingUiKey('dropex', 'Health & Beauty', 'Hair Care', 'hair-care');
  const drafts = { [mappedKey]: { targetCategoryId: 'health-beauty', targetSubcategoryId: '' } };

  assert.equal(drafts[unmappedKey], undefined);
  assert.notEqual(mappedKey, childNameKey);
  assert.notEqual(childNameKey, childIdKey);
  assert.match(mappedKey, /::parent$/u);
  assert.match(childNameKey, /::name:hair care$/u);
  assert.match(childIdKey, /::id:hair-care$/u);
});
