import type { SupplierReviewDraft } from '../services/supplierReviewEditor';
import type {
  ZyroCategorySuggestion,
  ZyroSuggestionCategory,
} from '../services/categorySuggestion/suggestZyroCategory';

export interface OperatorCategorySelection {
  category: string;
  subcategory: string;
  isSuggestionPreselected: boolean;
  requiresExplicitSave: boolean;
}

const emptySelection = (): OperatorCategorySelection => ({
  category: '',
  subcategory: '',
  isSuggestionPreselected: false,
  requiresExplicitSave: false,
});

const currentSelection = (draft: Pick<SupplierReviewDraft, 'category' | 'subcategory'>): OperatorCategorySelection => ({
  category: String(draft.category || '').trim(),
  subcategory: String(draft.subcategory || '').trim(),
  isSuggestionPreselected: false,
  requiresExplicitSave: false,
});

const hasAdminOwnedTaxonomy = (
  draft: Pick<SupplierReviewDraft, 'fieldOwnership'>,
): boolean => (
  draft.fieldOwnership?.category === 'admin'
  || draft.fieldOwnership?.subcategory === 'admin'
);

const activeCategory = (
  categories: readonly ZyroSuggestionCategory[],
  categoryId: string,
): ZyroSuggestionCategory | undefined => categories.find((category) => (
  category.id === categoryId
  && category.isActive === true
  && category.taxonomyCandidate !== true
));

export function resolveOperatorCategorySelection(
  draft: Pick<SupplierReviewDraft, 'category' | 'subcategory' | 'fieldOwnership'>,
  suggestion: Pick<ZyroCategorySuggestion, 'status' | 'categoryId' | 'subcategoryId' | 'confidence'>,
  categories: readonly ZyroSuggestionCategory[],
): OperatorCategorySelection {
  const existing = currentSelection(draft);

  // Never replace a persisted selection, especially one explicitly owned by Admin.
  if (hasAdminOwnedTaxonomy(draft) || existing.category || existing.subcategory) {
    return existing;
  }

  if (
    suggestion.status !== 'SUGGESTED'
    || !['HIGH', 'MEDIUM'].includes(suggestion.confidence)
    || !suggestion.categoryId
    || !suggestion.subcategoryId
  ) {
    return emptySelection();
  }

  const category = activeCategory(categories, suggestion.categoryId);
  const subcategory = category?.subcategories?.find((candidate) => (
    candidate.id === suggestion.subcategoryId
    && candidate.isActive !== false
    && candidate.taxonomyCandidate !== true
  ));

  // A suggestion is eligible only when the active canonical parent-child pair exists.
  if (!category || !subcategory) return emptySelection();

  return {
    category: category.id,
    subcategory: subcategory.id,
    isSuggestionPreselected: true,
    requiresExplicitSave: true,
  };
}
