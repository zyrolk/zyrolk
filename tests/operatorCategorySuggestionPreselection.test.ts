import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveOperatorCategorySelection } from '../src/utils/operatorSuggestionSelection';
import { hasProductReviewOperatorAccess } from '../functions/src/api/security/adminAuthorization';

const categories = [
  {
    id: 'home-kitchen',
    name: 'Home & Kitchen',
    isActive: true,
    subcategories: [
      { id: 'kitchen-tools', name: 'Kitchen Tools', isActive: true },
      { id: 'home-essentials', name: 'Home Essentials', isActive: true },
    ],
  },
  {
    id: 'home-garden',
    name: 'Home & Garden',
    isActive: true,
    subcategories: [{ id: 'home-essentials', name: 'Home Essentials', isActive: true }],
  },
] as const;

const draft = (overrides: Record<string, unknown> = {}) => ({
  category: '',
  subcategory: '',
  fieldOwnership: {},
  ...overrides,
});

const suggestion = (overrides: Record<string, unknown> = {}) => ({
  status: 'SUGGESTED' as const,
  categoryId: 'home-kitchen',
  subcategoryId: 'kitchen-tools',
  confidence: 'HIGH' as const,
  ...overrides,
});

test('HIGH-confidence valid pair is preselected locally and still requires Save', () => {
  const result = resolveOperatorCategorySelection(draft(), suggestion(), categories);
  assert.deepEqual(result, {
    category: 'home-kitchen',
    subcategory: 'kitchen-tools',
    isSuggestionPreselected: true,
    requiresExplicitSave: true,
  });
});

test('MEDIUM-confidence valid pair is preselected locally', () => {
  const result = resolveOperatorCategorySelection(draft(), suggestion({ confidence: 'MEDIUM' }), categories);
  assert.equal(result.isSuggestionPreselected, true);
  assert.equal(result.category, 'home-kitchen');
  assert.equal(result.subcategory, 'kitchen-tools');
});

test('LOW and NO_CONFIDENT_MATCH suggestions remain manual', () => {
  const low = resolveOperatorCategorySelection(draft(), suggestion({ confidence: 'LOW' }), categories);
  const none = resolveOperatorCategorySelection(draft(), suggestion({ status: 'NO_CONFIDENT_MATCH', categoryId: null, subcategoryId: null, confidence: 'LOW' }), categories);
  assert.equal(low.isSuggestionPreselected, false);
  assert.equal(none.category, '');
  assert.equal(none.subcategory, '');
});

test('inactive, candidate, and mismatched taxonomy pairs are rejected', () => {
  const inactiveCategory = [{ ...categories[0], isActive: false }] as const;
  const candidateSubcategory = [{ ...categories[0], subcategories: [{ ...categories[0].subcategories[0], taxonomyCandidate: true }] }] as const;
  const mismatched = resolveOperatorCategorySelection(draft(), suggestion({ categoryId: 'home-garden', subcategoryId: 'kitchen-tools' }), categories);
  assert.equal(resolveOperatorCategorySelection(draft(), suggestion(), inactiveCategory).isSuggestionPreselected, false);
  assert.equal(resolveOperatorCategorySelection(draft(), suggestion(), candidateSubcategory).isSuggestionPreselected, false);
  assert.equal(mismatched.isSuggestionPreselected, false);
});

test('saved Admin-owned selection is preserved', () => {
  const result = resolveOperatorCategorySelection(
    draft({ category: 'home-garden', subcategory: 'home-essentials', fieldOwnership: { category: 'admin', subcategory: 'admin' } }),
    suggestion(),
    categories,
  );
  assert.deepEqual(result, {
    category: 'home-garden',
    subcategory: 'home-essentials',
    isSuggestionPreselected: false,
    requiresExplicitSave: false,
  });
});

test('async taxonomy loading and product switching cannot leak a prior selection', () => {
  const pending = resolveOperatorCategorySelection(draft(), suggestion(), []);
  const loaded = resolveOperatorCategorySelection(draft(), suggestion(), categories);
  const nextProduct = resolveOperatorCategorySelection(draft(), suggestion({ categoryId: 'home-garden', subcategoryId: 'home-essentials' }), categories);
  assert.equal(pending.isSuggestionPreselected, false);
  assert.equal(loaded.category, 'home-kitchen');
  assert.equal(nextProduct.category, 'home-garden');
  assert.notEqual(nextProduct.category, loaded.category);
});

test('operator UI keeps explicit Save and existing authorization/publish gates', () => {
  const modal = readFileSync('src/components/ProductReviewOperatorModal.tsx', 'utf8');
  assert.equal(hasProductReviewOperatorAccess({ productReviewOperator: true }), true);
  assert.equal(hasProductReviewOperatorAccess({ admin: true }), false);
  assert.match(modal, /const \[hasSavedCategory, setHasSavedCategory\] = useState\(false\)/u);
  assert.match(modal, /Suggested category — not confirmed or saved/u);
  assert.match(modal, /onSaveDraft/iu);
  assert.match(modal, /const canPublish = hasSavedCategory && decisionReady && categoryPathReady && managedMediaReady/u);
  assert.match(modal, /taxonomyInteractionRef\.current = false/u);
  assert.match(modal, /appliedSuggestionKeyRef\.current = ''/u);
  assert.match(modal, /\}, \[item\.id\]\);/u);
});
