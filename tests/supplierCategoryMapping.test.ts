import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSupplierCategoryMappings,
  matchesSupplierCategoryFilter,
  normalizeSupplierCategory,
  parseSupplierCategoryMappings,
  resolveSupplierCategory,
} from '../src/services/supplierCategoryMapping';
import { matchesSupplierCategoryFilter as matchesScheduledSupplierCategoryFilter } from '../functions/src/scheduled/supplierCategoryMapping';

const categories = [
  { id: 'electronics', name: 'Electronics' },
  { id: 'home-kitchen', name: 'Home & Kitchen' },
];

test('supplier category mappings normalize and persist deterministically', () => {
  const mappings = parseSupplierCategoryMappings('  Smart_Gadgets =electronics\nKitchen Items=home-kitchen');
  assert.deepEqual(mappings, {
    'smart gadgets': 'electronics',
    'kitchen items': 'home-kitchen',
  });
  assert.equal(formatSupplierCategoryMappings(mappings), 'kitchen items=home-kitchen\nsmart gadgets=electronics');
  assert.equal(normalizeSupplierCategory(' SMART-GADGETS '), 'smart gadgets');
});

test('supplier category resolver uses persisted mapping then safe direct matching', () => {
  assert.equal(resolveSupplierCategory(['Smart Gadgets'], categories, { 'smart gadgets': 'electronics' }), 'electronics');
  assert.equal(resolveSupplierCategory(['Home & Kitchen'], categories, {}), 'home-kitchen');
  assert.equal(resolveSupplierCategory(['Unknown'], categories, {}), '');
  assert.equal(resolveSupplierCategory(['Smart Gadgets'], categories, { 'smart gadgets': 'missing' }), '');
});

test('supplier category filter resolves saved Zyro categories through persistent mappings', () => {
  const mappings = { 'smart gadgets': 'electronics', 'kitchen items': 'home-kitchen' };
  const cases = [matchesSupplierCategoryFilter, matchesScheduledSupplierCategoryFilter];

  cases.forEach((matchesFilter) => {
    assert.equal(matchesFilter(['Smart Gadgets'], ['Electronics'], categories, mappings), true);
    assert.equal(matchesFilter(['Kitchen Items'], ['electronics'], categories, mappings), false);
    assert.equal(matchesFilter(['Home & Kitchen'], ['Home & Kitchen'], categories, mappings), true);
    assert.equal(matchesFilter(['Unknown'], [], categories, mappings), true);
  });
});

test('supplier category filter never substitutes product-title matching for category matching', () => {
  assert.equal(matchesSupplierCategoryFilter(['Kitchen Items'], ['Electronics'], categories, {
    'kitchen items': 'home-kitchen',
  }), false);
});
