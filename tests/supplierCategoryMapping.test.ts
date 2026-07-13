import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSupplierCategoryMappings,
  normalizeSupplierCategory,
  parseSupplierCategoryMappings,
  resolveSupplierCategory,
} from '../src/services/supplierCategoryMapping';

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
