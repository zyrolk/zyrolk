import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductForSave } from '../src/services/products/productValidation';
import type { Category, Product } from '../src/types';

const categories: Category[] = [
  { id: 'electronics', name: 'Electronics', icon: 'Layers', isActive: true },
  { id: 'hidden', name: 'Hidden', icon: 'Layers', isActive: false },
];
const product = (overrides: Partial<Product> = {}): Product => ({
  id: 'phone', name: 'Phone', description: '', price: 100, originalPrice: 120,
  imageUrl: 'https://example.com/phone.jpg', imageUrls: ['https://example.com/phone-2.jpg'],
  category: 'electronics', rating: 5, reviewsCount: 0, sku: 'ZY-1', stock: 2, specs: {}, isActive: true,
  ...overrides,
});

test('valid product passes catalog validation and an edit may retain its own SKU', () => {
  const current = product();
  assert.deepEqual(validateProductForSave({ product: current, products: [current], categories, editingProductId: current.id }), []);
});

test('published products require valid prices, stock, images, existing active category and unique SKU', () => {
  const errors = validateProductForSave({
    product: product({ id: '', name: '', price: 0, originalPrice: -1, stock: 1.5, imageUrl: '/bad.jpg', imageUrls: ['javascript:bad'], category: 'hidden', sku: 'DUP' }),
    products: [product({ id: 'existing', sku: 'dup' })], categories,
  });
  assert.deepEqual(errors, [
    'Product name is required.', 'Product slug / ID cannot be empty.', 'Sale price must be greater than zero.',
    'Regular price must be greater than zero when provided.', 'Stock must be a non-negative whole number.',
    'Primary product image must use a valid http or https URL.', 'Every gallery image must use a valid http or https URL.',
    'Published products must use an active category.', 'Product SKU "DUP" is already in use.',
  ]);
});

test('draft products may remain assigned to an inactive category', () => {
  assert.deepEqual(validateProductForSave({ product: product({ category: 'hidden', isActive: false }), products: [], categories }), []);
});
