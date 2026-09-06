import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LAUNCH_TAXONOMY,
  LAUNCH_TAXONOMY_CONFIRMATION,
  planLaunchTaxonomy,
  summarizeLaunchTaxonomyPlan,
} from '../scripts/launchTaxonomyBootstrap';

const existing = (id: string, data: Record<string, unknown>) => ({ id, data });

test('empty database plans exactly five categories and three brands', () => {
  const plan = planLaunchTaxonomy([], []);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.createCategories.map((entry) => entry.id), [
    'accessories',
    'electronics',
    'home-kitchen',
    'solar-lighting',
    'home-garden',
  ]);
  assert.deepEqual(plan.createBrands.map((entry) => entry.id), [
    'generic',
    'california-beauty',
    'kinoki',
  ]);
  assert.deepEqual(plan.updateCategories, []);
  assert.deepEqual(plan.updateBrands, []);
  assert.equal(plan.productWrites, 0);
});

test('desired subcategories have exactly one configured parent', () => {
  const parents = new Map<string, string>();
  for (const category of LAUNCH_TAXONOMY.categories) {
    for (const subcategory of category.subcategories) {
      assert.equal(parents.has(subcategory.id), false);
      parents.set(subcategory.id, category.id);
      assert.equal(subcategory.isActive, true);
    }
  }
  assert.equal(parents.size, 17);
  assert.equal(parents.get('painting-tools'), 'home-garden');
  assert.equal(parents.get('watches'), 'accessories');
  assert.equal(parents.get('power-banks'), 'electronics');
});

test('re-running against compatible active records is idempotent', () => {
  const categories = LAUNCH_TAXONOMY.categories.map((category) => existing(category.id, {
    name: category.name,
    icon: category.icon,
    isActive: true,
    subcategories: category.subcategories,
    specificationTemplate: category.specificationTemplate.map((field) => ({
      name: field.name,
      required: field.required === true,
    })),
  }));
  const brands = LAUNCH_TAXONOMY.brands.map((brand) => existing(brand.id, {
    name: brand.name,
    isActive: true,
  }));
  const plan = planLaunchTaxonomy(categories, brands);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.createCategories, []);
  assert.deepEqual(plan.updateCategories, []);
  assert.deepEqual(plan.createBrands, []);
  assert.deepEqual(plan.updateBrands, []);
  assert.equal(summarizeLaunchTaxonomyPlan(plan).valid, true);
});

test('conflicting category and brand IDs fail closed', () => {
  const plan = planLaunchTaxonomy(
    [existing('electronics', {
      name: 'Unrelated Catalog',
      isActive: true,
      subcategories: [],
    })],
    [existing('generic', {
      name: 'Not Generic',
      isActive: true,
    })],
  );
  assert.match(plan.errors.join('\n'), /Category electronics exists with conflicting name/u);
  assert.match(plan.errors.join('\n'), /Brand generic exists with conflicting name/u);
});

test('subcategory ownership conflicts fail closed instead of moving an existing subcategory', () => {
  const plan = planLaunchTaxonomy([
    existing('legacy', {
      name: 'Legacy',
      isActive: true,
      subcategories: [{ id: 'painting-tools', name: 'Painting Tools', isActive: true }],
    }),
  ], []);
  assert.match(plan.errors.join('\n'), /painting-tools/u);
  assert.equal(plan.createCategories.length, 5);
});

test('inactive or invalid existing records are never silently reused', () => {
  const plan = planLaunchTaxonomy(
    [
      existing('electronics', { name: 'Electronics', isActive: false }),
      existing('accessories', {
        name: 'Accessories',
        isActive: true,
        subcategories: [{ id: 'watches', name: 'Watches', isActive: false }],
      }),
    ],
    [existing('generic', { name: 'Generic', isActive: false })],
  );
  assert.match(plan.errors.join('\n'), /electronics is inactive or invalid/u);
  assert.match(plan.errors.join('\n'), /watches.*inactive/u);
  assert.match(plan.errors.join('\n'), /generic is inactive or invalid/u);
});

test('bootstrap plan never writes products or supplier review mappings', () => {
  const plan = planLaunchTaxonomy([], []);
  assert.equal(plan.productWrites, 0);
  assert.equal('products' in plan, false);
  assert.equal('supplierReview' in plan, false);
});

test('production confirmation is explicit and stable', () => {
  assert.equal(LAUNCH_TAXONOMY_CONFIRMATION, 'CREATE_MINIMAL_LAUNCH_TAXONOMY');
});
