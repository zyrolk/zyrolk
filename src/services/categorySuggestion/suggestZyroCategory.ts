import type { SupplierReviewDraft } from '../supplierReviewEditor';
import { supplierDescriptionPlainText } from '../supplierReviewDescription';
import { updateSupplierReviewDraftField } from '../supplierReviewEditor';
import { ZYRO_CATEGORY_RULES, ZyroCategoryRule } from './zyroCategoryRules';

export interface ZyroSuggestionSubcategory {
  id: string;
  name?: string;
  isActive?: boolean;
  taxonomyCandidate?: boolean;
}

export interface ZyroSuggestionCategory {
  id: string;
  name?: string;
  isActive?: boolean;
  taxonomyCandidate?: boolean;
  subcategories?: readonly ZyroSuggestionSubcategory[];
}

export interface SuggestZyroCategoryInput {
  productName: string;
  description: string;
  productType?: string;
  model?: string;
  brand?: string;
  keywords?: readonly string[];
  specifications?: Readonly<Record<string, unknown>>;
  categories: readonly ZyroSuggestionCategory[];
}

export interface ZyroCategorySuggestionAlternative {
  categoryId: string;
  subcategoryId: string | null;
}

export interface ZyroCategorySuggestion {
  status: 'SUGGESTED' | 'NO_CONFIDENT_MATCH';
  categoryId: string | null;
  subcategoryId: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
  alternatives: ZyroCategorySuggestionAlternative[];
  engine: 'rules-v1';
}

interface EvidenceFields {
  title: string;
  description: string;
  metadata: string;
}

interface ScoredCandidate {
  categoryId: string;
  subcategoryId: string | null;
  score: number;
  reasons: string[];
  strongTitle: boolean;
  hasRequiredSubcategory: boolean;
}

const normalizeText = (value: unknown): string => supplierDescriptionPlainText(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const phraseInText = (text: string, phrase: string): boolean => {
  const normalizedPhrase = normalizeText(phrase);
  return Boolean(normalizedPhrase) && ` ${text} `.includes(` ${normalizedPhrase} `);
};

const firstMatchingPhrase = (text: string, phrases: readonly string[]): string | null => (
  phrases.find((phrase) => phraseInText(text, phrase)) || null
);

const addReason = (reasons: string[], phrase: string, field: string): void => {
  const reason = `Matched "${phrase}" in ${field}`;
  if (!reasons.includes(reason)) reasons.push(reason);
};

const categoryIsUsable = (category: ZyroSuggestionCategory | undefined): category is ZyroSuggestionCategory => (
  Boolean(category)
  && category.isActive === true
  && category.taxonomyCandidate !== true
);

const subcategoryForRule = (
  category: ZyroSuggestionCategory,
  subcategoryId: string | undefined,
): ZyroSuggestionSubcategory | null => {
  if (!subcategoryId) return null;
  const subcategory = category.subcategories?.find((candidate) => candidate.id === subcategoryId);
  return subcategory && subcategory.isActive !== false && subcategory.taxonomyCandidate !== true
    ? subcategory
    : null;
};

const hasActiveSubcategories = (category: ZyroSuggestionCategory): boolean => (
  (category.subcategories || []).some((subcategory) => subcategory.isActive !== false && subcategory.taxonomyCandidate !== true)
);

const evidenceFor = (input: SuggestZyroCategoryInput): EvidenceFields => ({
  title: normalizeText([input.productName, input.productType, input.model].filter(Boolean).join(' ')),
  description: normalizeText(input.description),
  metadata: normalizeText([
    input.brand,
    ...(input.keywords || []),
    ...Object.entries(input.specifications || {}).flatMap(([key, value]) => [key, String(value ?? '')]),
  ].filter(Boolean).join(' ')),
});

const scoreRule = (
  rule: ZyroCategoryRule,
  evidence: EvidenceFields,
): { score: number; reasons: string[]; strongTitle: boolean } | null => {
  const strongPhrases = [...rule.strongPhrases, ...(rule.aliases || [])];
  if ((rule.negativeKeywords || []).some((keyword) => phraseInText(evidence.title, keyword))) return null;

  const reasons: string[] = [];
  let score = 0;
  const strongTitlePhrase = firstMatchingPhrase(evidence.title, strongPhrases);
  const strongDescriptionPhrase = firstMatchingPhrase(evidence.description, strongPhrases);
  const keywordTitle = firstMatchingPhrase(evidence.title, rule.keywords);
  const keywordDescription = firstMatchingPhrase(evidence.description, rule.keywords);
  const keywordMetadata = firstMatchingPhrase(evidence.metadata, rule.keywords);

  if (strongTitlePhrase) {
    score += 10;
    addReason(reasons, strongTitlePhrase, 'product name');
  }
  if (keywordTitle) {
    score += 4;
    addReason(reasons, keywordTitle, 'product name');
  }
  if (strongDescriptionPhrase) {
    score += 3;
    addReason(reasons, strongDescriptionPhrase, 'description');
  }
  if (keywordDescription) {
    score += 1;
    addReason(reasons, keywordDescription, 'description');
  }
  if (keywordMetadata) {
    score += 1;
    addReason(reasons, keywordMetadata, 'product metadata');
  }
  if ((rule.negativeKeywords || []).some((keyword) => phraseInText(evidence.description, keyword))) score -= 3;
  return score > 0 ? { score, reasons, strongTitle: Boolean(strongTitlePhrase) } : null;
};

const noMatch = (): ZyroCategorySuggestion => ({
  status: 'NO_CONFIDENT_MATCH',
  categoryId: null,
  subcategoryId: null,
  confidence: 'LOW',
  reasons: [],
  alternatives: [],
  engine: 'rules-v1',
});

export function suggestZyroCategory(input: SuggestZyroCategoryInput): ZyroCategorySuggestion {
  const evidence = evidenceFor(input);
  const candidates = new Map<string, ScoredCandidate>();

  for (const rule of ZYRO_CATEGORY_RULES) {
    const category = input.categories.find((candidate) => candidate.id === rule.categoryId);
    if (!categoryIsUsable(category)) continue;
    const ruleSubcategory = subcategoryForRule(category, rule.subcategoryId);
    if (rule.subcategoryId && !ruleSubcategory) continue;
    const scored = scoreRule(rule, evidence);
    if (!scored) continue;
    const key = `${category.id}|${ruleSubcategory?.id || ''}`;
    const current = candidates.get(key);
    const hasRequiredSubcategory = !hasActiveSubcategories(category) || Boolean(ruleSubcategory);
    candidates.set(key, current
      ? {
        ...current,
        score: current.score + scored.score,
        reasons: [...new Set([...current.reasons, ...scored.reasons])],
        strongTitle: current.strongTitle || scored.strongTitle,
      }
      : {
        categoryId: category.id,
        subcategoryId: ruleSubcategory?.id || null,
        score: scored.score,
        reasons: scored.reasons,
        strongTitle: scored.strongTitle,
        hasRequiredSubcategory,
      });
  }

  const ranked = [...candidates.values()].sort((left, right) => (
    right.score - left.score
    || left.categoryId.localeCompare(right.categoryId)
    || String(left.subcategoryId || '').localeCompare(String(right.subcategoryId || ''))
  ));
  const best = ranked[0];
  if (!best) return noMatch();
  const runnerUp = ranked[1];
  const lead = runnerUp ? best.score - runnerUp.score : best.score;
  if (best.score < 5 || (runnerUp && lead === 0) || !best.hasRequiredSubcategory) return noMatch();

  const confidence: ZyroCategorySuggestion['confidence'] = best.score >= 10 && lead >= 6 && best.strongTitle
    ? 'HIGH'
    : 'MEDIUM';
  return {
    status: 'SUGGESTED',
    categoryId: best.categoryId,
    subcategoryId: best.subcategoryId,
    confidence,
    reasons: best.reasons.slice(0, 3),
    alternatives: confidence === 'MEDIUM'
      ? ranked.slice(1, 3).map((candidate) => ({ categoryId: candidate.categoryId, subcategoryId: candidate.subcategoryId }))
      : [],
    engine: 'rules-v1',
  };
}

export function applyZyroCategorySuggestion(
  draft: SupplierReviewDraft,
  suggestion: ZyroCategorySuggestion,
): SupplierReviewDraft {
  if (suggestion.status !== 'SUGGESTED' || !suggestion.categoryId) return draft;
  const withCategory = updateSupplierReviewDraftField(draft, 'category', {
    category: suggestion.categoryId,
  });
  return updateSupplierReviewDraftField(withCategory, 'subcategory', {
    subcategory: suggestion.subcategoryId || '',
  });
}
