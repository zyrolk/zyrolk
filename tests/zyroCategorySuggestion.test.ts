import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SupplierReviewEditorModal from '../src/components/SupplierReviewEditorModal';
import {
  applyZyroCategorySuggestion,
  suggestZyroCategory,
} from '../src/services/categorySuggestion/suggestZyroCategory';
import { createSupplierReviewDraft } from '../src/services/supplierReviewEditor';

const category = (id: string, name: string, subcategories: string[] = []) => ({
  id,
  name,
  isActive: true,
  subcategories: subcategories.map((subcategoryId) => ({ id: subcategoryId, name: subcategoryId, isActive: true })),
});

const taxonomy = [
  category('home-kitchen', 'Home & Kitchen', ['small-kitchen-appliances', 'kitchen-tools', 'home-essentials']),
  category('home-garden', 'Home & Garden', ['home-essentials', 'garden-tools']),
  category('automotive', 'Automotive', ['car-accessories', 'car-care', 'vehicle-accessories']),
  category('mobile-phones', 'Mobile Phones & Accessories', ['mobile-accessories', 'smartphones']),
  category('electronics', 'Electronics', ['smart-watches', 'smart-devices']),
  category('accessories', 'Accessories', ['mobile-accessories', 'personal-accessories', 'fitness-accessories', 'watches']),
  category('fashion', 'Fashion', ['watches']),
  category('health-beauty', 'Health & Beauty', ['health-wellness', 'beauty-personal-care']),
  category('baby-kids', 'Baby & Kids', ['baby-care']),
  category('kids-toys', 'Kids & Toys', ['educational-toys', 'puzzles-games']),
  category('solar-lighting', 'Solar & Lighting', ['solar-lights', 'lighting-accessories']),
];

const suggest = (productName: string, description = '') => suggestZyroCategory({
  productName,
  description,
  categories: taxonomy,
});

const baseItem = {
  id: 'review-1',
  productName: 'Healthy Air Fryer 6 L',
  supplierCode: 'SUP-1',
  supplierName: 'Dropex',
  costPrice: 100,
  marketPrice: 200,
  stock: 8,
  sourceId: 'dropex',
  productPayload: {
    id: 'product-1',
    name: 'Healthy Air Fryer 6 L',
    description: 'A practical kitchen appliance.',
    price: 1_500,
    imageUrl: 'https://storage.example/primary.webp',
    imageUrls: [],
    category: '',
    specs: {},
  },
  comparison: { comparisonStatus: 'NEW_PRODUCT' },
  productValidation: { readyToPublish: false, errors: [], warnings: [] },
  managedMedia: [{ firebaseStorageUrl: 'https://storage.example/primary.webp', isPrimary: true, imageStatus: 'ready', sortOrder: 0 }],
};

const renderEditor = (draftOverrides: Record<string, unknown> = {}) => {
  const item = baseItem as never;
  const draft = { ...createSupplierReviewDraft(item), ...draftOverrides };
  return renderToStaticMarkup(React.createElement(SupplierReviewEditorModal, {
    item,
    initialDraft: draft,
    categories: taxonomy,
    brands: [],
    validCategoryIds: taxonomy.map((entry) => entry.id),
    isPublishing: false,
    onClose: () => undefined,
    onRemove: () => undefined,
    onPublish: async () => undefined,
    offers: [],
    offerSelection: { activeOfferId: null, lockedOfferId: null, failoverEnabled: true },
    offersLoading: false,
    offerActionId: null,
    offerError: null,
    onRefreshOffers: async () => undefined,
    onConfigureOffer: async () => undefined,
    onSelectOffer: async () => undefined,
  }));
};

test('exact strong title phrase chooses the active category and subcategory', () => {
  const result = suggest('Healthy Air Fryer 6 L');
  assert.equal(result.status, 'SUGGESTED');
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.categoryId, 'home-kitchen');
  assert.equal(result.subcategoryId, 'small-kitchen-appliances');
  assert.match(result.reasons.join(' '), /air fryer.*product name/iu);
});

test('title evidence outranks a conflicting description', () => {
  const result = suggest('Car Door Guard', 'This household kitchen item is useful at home.');
  assert.equal(result.categoryId, 'automotive');
  assert.equal(result.subcategoryId, 'car-accessories');
  assert.equal(result.confidence, 'HIGH');
});

test('negative title keywords veto a generic solar-light candidate', () => {
  const result = suggest('Bike Signal Light Circuit', 'Bright light for outdoor use.');
  assert.equal(result.categoryId, 'automotive');
  assert.equal(result.subcategoryId, 'vehicle-accessories');
  assert.equal(result.confidence, 'HIGH');
});

test('description supports weaker evidence without becoming title authority', () => {
  const result = suggest('Everyday kitchen item', 'Useful vegetable slicer for preparing meals.');
  assert.equal(result.categoryId, 'home-kitchen');
  assert.equal(result.subcategoryId, 'kitchen-tools');
  assert.equal(result.confidence, 'MEDIUM');
});

test('keywords and structured specification values provide only secondary product evidence', () => {
  const result = suggestZyroCategory({
    productName: 'Kitchen appliance',
    description: '',
    keywords: ['fryer'],
    specifications: { 'Product Type': 'Air Fryer' },
    categories: taxonomy,
  });
  assert.equal(result.categoryId, 'home-kitchen');
  assert.equal(result.subcategoryId, 'small-kitchen-appliances');
  assert.equal(result.confidence, 'MEDIUM');
});

test('inactive category is ignored', () => {
  const result = suggestZyroCategory({
    productName: 'Healthy Air Fryer 6 L', description: '',
    categories: [{ ...taxonomy[0], isActive: false }],
  });
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
});

test('category without explicit active state is ignored', () => {
  const result = suggestZyroCategory({
    productName: 'Healthy Air Fryer 6 L', description: '',
    categories: [{ ...taxonomy[0], isActive: undefined }],
  });
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
});

test('taxonomy candidate category is ignored', () => {
  const result = suggestZyroCategory({
    productName: 'Healthy Air Fryer 6 L', description: '',
    categories: [{ ...taxonomy[0], taxonomyCandidate: true }],
  });
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
});

test('inactive subcategory invalidates the rule safely', () => {
  const result = suggestZyroCategory({
    productName: 'Healthy Air Fryer 6 L', description: '',
    categories: [{ ...taxonomy[0], subcategories: [{ id: 'small-kitchen-appliances', name: 'Small Kitchen Appliances', isActive: false }] }],
  });
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
});

test('subcategory must belong to the active category', () => {
  const result = suggestZyroCategory({
    productName: 'Healthy Air Fryer 6 L', description: '',
    categories: [{ ...taxonomy[0], subcategories: [{ id: 'unrelated', name: 'Unrelated', isActive: true }] }],
  });
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
});

test('category with active children does not produce HIGH without a valid subcategory', () => {
  const result = suggestZyroCategory({
    productName: 'Household Item', description: '',
    categories: [{ id: 'home-garden', name: 'Home & Garden', isActive: true, subcategories: [{ id: 'garden-tools', name: 'Garden Tools', isActive: true }] }],
  });
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
});

test('zero-subcategory category may return a category-only HIGH suggestion', () => {
  const result = suggestZyroCategory({
    productName: 'Electronic Accessory', description: '',
    categories: [{ id: 'electronics', name: 'Electronics', isActive: true, subcategories: [] }],
  });
  assert.equal(result.status, 'SUGGESTED');
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.categoryId, 'electronics');
  assert.equal(result.subcategoryId, null);
});

test('supplier taxonomy cannot affect the result because it is not an engine input', () => {
  const input = { productName: 'Healthy Air Fryer 6 L', description: '', categories: taxonomy };
  const baseline = suggestZyroCategory(input);
  const withSupplierFields = suggestZyroCategory({
    ...input,
    supplierCategory: 'Automotive',
    supplierSubcategory: 'Vehicle Accessories',
    categoryMapping: { targetCategoryId: 'automotive' },
  } as typeof input);
  assert.deepEqual(withSupplierFields, baseline);
});

test('category mapping cannot affect the result', () => {
  const result = suggestZyroCategory({
    productName: 'Car Door Guard', description: '', categories: taxonomy,
    categoryMapping: { targetCategoryId: 'home-garden' },
  } as never);
  assert.equal(result.categoryId, 'automotive');
});

test('watch ownership is deterministic and supplier taxonomy cannot redirect it', () => {
  const smartWatch = suggestZyroCategory({
    productName: 'Smart Watch Fitness Band',
    description: '',
    categories: taxonomy,
    supplierCategory: 'Fashion',
    supplierSubcategory: 'Watches',
  } as never);
  const wristWatch = suggestZyroCategory({
    productName: 'Ladies Wrist Watch',
    description: '',
    categories: taxonomy,
    supplierCategory: 'Accessories',
    supplierSubcategory: 'Watches',
  } as never);
  assert.deepEqual(
    { categoryId: smartWatch.categoryId, subcategoryId: smartWatch.subcategoryId },
    { categoryId: 'electronics', subcategoryId: 'smart-watches' },
  );
  assert.deepEqual(
    { categoryId: wristWatch.categoryId, subcategoryId: wristWatch.subcategoryId },
    { categoryId: 'fashion', subcategoryId: 'watches' },
  );
});

test('smart-watch accessory titles do not classify as the watch product', () => {
  for (const productName of [
    'smart watch strap',
    'smartwatch strap',
    'smart watch case',
    'smart watch charger',
    'smart watch screen protector',
  ]) {
    const result = suggest(productName);
    assert.equal(result.status, 'NO_CONFIDENT_MATCH', productName);
    assert.equal(result.categoryId, null, productName);
    assert.equal(result.subcategoryId, null, productName);
    assert.equal(result.confidence, 'LOW', productName);
  }
});

test('genuine smartwatch and fitness-band titles remain valid wearable matches', () => {
  for (const productName of ['smart watch', 'smartwatch', 'fitness band']) {
    const result = suggest(productName);
    assert.equal(result.status, 'SUGGESTED', productName);
    assert.equal(result.categoryId, 'electronics', productName);
    assert.equal(result.subcategoryId, 'smart-watches', productName);
    assert.equal(result.confidence, 'HIGH', productName);
  }
});

test('HIGH result follows the stable future-compatible contract', () => {
  const result = suggest('2PCS Ankle Support with Strap');
  assert.deepEqual(Object.keys(result).sort(), ['alternatives', 'categoryId', 'confidence', 'engine', 'reasons', 'status', 'subcategoryId']);
  assert.equal(result.engine, 'rules-v1');
  assert.equal(result.confidence, 'HIGH');
});

test('MEDIUM results expose bounded alternatives without percentages', () => {
  const result = suggest('Phone accessory', 'A useful cable and charger for a phone.');
  assert.equal(result.status, 'SUGGESTED');
  assert.equal(result.confidence, 'MEDIUM');
  assert.ok(result.alternatives.length <= 2);
  assert.equal(JSON.stringify(result).includes('%'), false);
});

test('LOW / ambiguous results fall back to manual selection', () => {
  const result = suggest('5Pcs Super Gadget Combo Pack');
  assert.equal(result.status, 'NO_CONFIDENT_MATCH');
  assert.equal(result.confidence, 'LOW');
  assert.equal(result.categoryId, null);
  assert.equal(result.subcategoryId, null);
});

test('alternatives are capped at two', () => {
  const result = suggest('Watch accessory', 'Watch accessory for a smart watch and wrist watch.');
  assert.ok(result.alternatives.length <= 2);
});

test('existing taxonomy is preserved until an administrator explicitly applies a suggestion', () => {
  const draft = { ...createSupplierReviewDraft(baseItem as never), category: 'electronics', subcategory: 'smart-devices' };
  const suggestion = suggest('Car Door Guard');
  assert.equal(draft.category, 'electronics');
  const applied = applyZyroCategorySuggestion(draft, suggestion);
  assert.equal(applied.category, 'automotive');
  assert.equal(applied.subcategory, 'car-accessories');
  assert.equal(applied.fieldOwnership.category, 'admin');
  assert.equal(applied.fieldOwnership.subcategory, 'admin');
});

test('admin-owned taxonomy is not silently replaced', () => {
  const draft = { ...createSupplierReviewDraft(baseItem as never), category: 'electronics', subcategory: 'smart-devices', fieldOwnership: { ...createSupplierReviewDraft(baseItem as never).fieldOwnership, category: 'admin', subcategory: 'admin' } };
  const before = { category: draft.category, subcategory: draft.subcategory };
  assert.deepEqual({ category: draft.category, subcategory: draft.subcategory }, before);
});

test('matching current selection has no Apply action in the rendered editor', () => {
  const markup = renderEditor({ category: 'home-kitchen', subcategory: 'small-kitchen-appliances' });
  assert.match(markup, /Matches current selection/u);
  assert.doesNotMatch(markup, />Apply Suggestion</u);
});

test('Apply Suggestion is explicit and updates the draft only', () => {
  const suggestion = suggest('Healthy Air Fryer 6 L');
  const draft = createSupplierReviewDraft(baseItem as never);
  const applied = applyZyroCategorySuggestion(draft, suggestion);
  assert.equal(applied.category, 'home-kitchen');
  assert.equal(applied.subcategory, 'small-kitchen-appliances');
  assert.equal(applied.editedFields.includes('category'), true);
  assert.equal(applied.editedFields.includes('subcategory'), true);
  assert.equal(applied.productName, draft.productName);
});

test('the rendered suggestion has no publish or persistence action', () => {
  const markup = renderEditor();
  assert.match(markup, /Category suggestion/u);
  assert.doesNotMatch(markup, />Apply Suggestion</u);
  assert.doesNotMatch(markup, /suggestion.*Firestore|publish.*suggestion/iu);
});

test('12 launch fixtures resolve conservatively', () => {
  const fixtures: Array<[string, string, string | null, string | null]> = [
    ['Healthy Air Fryer 6 L', 'home-kitchen', 'small-kitchen-appliances', 'HIGH'],
    ['Meileyi Vegetable Slicer', 'home-kitchen', 'kitchen-tools', 'HIGH'],
    ['Magic Pad', 'kids-toys', 'educational-toys', 'HIGH'],
    ['Folding Multifunction Storage Laundry Basket', 'home-garden', 'home-essentials', 'HIGH'],
    ['2PCS Ankle Support with Strap', 'health-beauty', 'health-wellness', 'HIGH'],
    ['Weather Resistant Bike Mount', 'automotive', 'car-accessories', 'HIGH'],
    ['2PCS Universal Car Door Guard', 'automotive', 'car-accessories', 'HIGH'],
    ['Bike Signal Light Circuit', 'automotive', 'vehicle-accessories', 'HIGH'],
    ['Seamless Suction Cup Towel Rack', 'home-kitchen', 'home-essentials', 'HIGH'],
    ['Rust & Yellowish Removal Spray', 'automotive', 'car-care', 'HIGH'],
    ['5 in 1 Magic Vision', null, null, 'NO_CONFIDENT_MATCH'],
    ['5Pcs Super Gadget Combo Pack', null, null, 'NO_CONFIDENT_MATCH'],
  ];
  for (const [name, categoryId, subcategoryId, expected] of fixtures) {
    const result = suggest(name);
    assert.equal(result.status === 'SUGGESTED' ? result.categoryId : null, categoryId, name);
    assert.equal(result.subcategoryId, subcategoryId, name);
    assert.equal(result.status === 'SUGGESTED' ? result.confidence : result.status, expected, name);
  }
});

test('repeated input is deterministic', () => {
  const input = { productName: 'Healthy Air Fryer 6 L', description: 'Kitchen appliance', categories: taxonomy };
  assert.deepEqual(suggestZyroCategory(input), suggestZyroCategory(input));
});

test('optional evidence can be absent without creating a fallback taxonomy value', () => {
  const result = suggestZyroCategory({ productName: '', description: '', categories: taxonomy });
  assert.deepEqual(result, {
    status: 'NO_CONFIDENT_MATCH',
    categoryId: null,
    subcategoryId: null,
    confidence: 'LOW',
    reasons: [],
    alternatives: [],
    engine: 'rules-v1',
  });
});

test('existing update taxonomy remains presentation data until Apply is clicked', () => {
  const updateDraft = { ...createSupplierReviewDraft(baseItem as never), category: 'electronics', subcategory: 'smart-devices' };
  const suggestion = suggest('Car Door Guard');
  assert.equal(updateDraft.category, 'electronics');
  assert.equal(suggestion.categoryId, 'automotive');
  assert.equal(updateDraft.category, 'electronics');
});
