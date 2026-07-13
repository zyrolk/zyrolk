import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCategoryProductCounts,
  canDeleteCategory,
  categoryMatches,
  getActiveCategories,
  isDuplicateCategorySlug,
  normalizeCategoryName,
  normalizeCategorySlug,
  resolveCategoryImage,
  sortCategoriesAlphabetically,
} from '../src/services/categories/categoryUtils';
import type { Category, Product } from '../src/types';

const category = (id: string, name: string, imageUrl?: string): Category => ({ id, name, icon: 'Layers', imageUrl });
const product = (id: string, categoryId: string, isActive = true): Product => ({
  id,
  name: `Product ${id}`,
  description: '',
  price: 100,
  imageUrl: `/products/${id}.webp`,
  category: categoryId,
  rating: 0,
  reviewsCount: 0,
  isActive,
  stock: 1,
  specs: {},
});

test('category names and slugs normalize whitespace without damaging Unicode names', () => {
  assert.equal(normalizeCategoryName('  ස්මාර්ට්   උපාංග  '), 'ස්මාර්ට් උපාංග');
  assert.equal(normalizeCategorySlug('  Smart   Home__Devices  '), 'smart-home-devices');
  assert.equal(normalizeCategorySlug(' Audio / Video! '), 'audio-video');
});

test('duplicate slug detection is normalized and case insensitive', () => {
  const categories = [category('smart-home', 'Smart Home')];
  assert.equal(isDuplicateCategorySlug(categories, ' SMART__HOME '), true);
  assert.equal(isDuplicateCategorySlug(categories, 'wearables'), false);
});

test('alphabetical ordering is deterministic, numeric aware, and immutable', () => {
  const source = [category('z', 'Zulu'), category('a10', 'Alpha 10'), category('a2', 'alpha 2')];
  const before = source.map((item) => item.id);
  const sorted = sortCategoriesAlphabetically(source);
  assert.deepEqual(sorted.map((item) => item.id), ['a2', 'a10', 'z']);
  assert.deepEqual(source.map((item) => item.id), before);
  assert.notEqual(sorted, source);
});

test('active category projection hides only explicitly inactive categories', () => {
  const legacy = category('legacy', 'Legacy');
  const inactive = { ...category('inactive', 'Inactive'), isActive: false };
  assert.deepEqual(getActiveCategories([legacy, inactive]).map((item) => item.id), ['legacy']);
});

test('category matching uses the shared normalized ID rule', () => {
  assert.equal(categoryMatches(' Smart__Home ', 'smart-home'), true);
  assert.equal(categoryMatches('smart-home', 'wearables'), false);
});

test('category counts keep active and total product counts separate', () => {
  const categories = [category('electronics', 'Electronics'), category('empty', 'Empty')];
  const products = [product('active', ' Electronics ', true), product('inactive', 'electronics', false)];
  const counts = buildCategoryProductCounts(categories, products);
  assert.deepEqual(counts.electronics, { active: 1, total: 2 });
  assert.deepEqual(counts.empty, { active: 0, total: 0 });
  assert.equal(Object.isFrozen(counts), true);
  assert.equal(Object.isFrozen(counts.electronics), true);
});

test('delete is blocked for active or inactive references and allowed only when empty', () => {
  assert.equal(canDeleteCategory({ active: 1, total: 1 }), false);
  assert.equal(canDeleteCategory({ active: 0, total: 1 }), false);
  assert.equal(canDeleteCategory({ active: 0, total: 0 }), true);
  assert.equal(canDeleteCategory(undefined), true);
});

test('category image priority is stored image, fallback, product image, then placeholder', () => {
  const products = [product('one', 'electronics')];
  assert.equal(resolveCategoryImage(category('electronics', 'Electronics', '/stored.webp'), products, { electronics: '/fallback.webp' }), '/stored.webp');
  assert.equal(resolveCategoryImage(category('electronics', 'Electronics'), products, { electronics: '/fallback.webp' }), '/fallback.webp');
  assert.equal(resolveCategoryImage(category('electronics', 'Electronics'), products, {}), '/products/one.webp');
  assert.match(resolveCategoryImage(category('empty', 'Empty'), [], {}), /^https:\/\//);
});
