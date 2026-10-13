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
  taxonomyProposals?: readonly ZyroTaxonomyProposal[];
}

export interface ZyroCategorySuggestionAlternative {
  categoryId: string;
  subcategoryId: string | null;
}

export type ZyroMissingTaxonomyKind = 'missing_subcategory' | 'missing_category';

export interface ZyroTaxonomyProposal {
  proposalId: string;
  revision: string;
  parentCategoryId: string;
  parentCategoryLabel: string;
  proposedLabel: string;
  proposedSlug: string;
  status?: string;
  parentActive: boolean;
  collision: boolean;
}

export interface ZyroMissingTaxonomyProposal {
  kind: ZyroMissingTaxonomyKind;
  proposal: ZyroTaxonomyProposal;
  confidence: 'MEDIUM';
  evidence: string[];
  creationSupported: boolean;
}

export interface ZyroCategorySuggestion {
  status: 'SUGGESTED' | 'NO_CONFIDENT_MATCH' | 'MISSING_TAXONOMY_PROPOSAL';
  categoryId: string | null;
  subcategoryId: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
  alternatives: ZyroCategorySuggestionAlternative[];
  engine: 'rules-v1';
  missingTaxonomyProposal?: ZyroMissingTaxonomyProposal;
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

const PROPOSAL_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'new', 'item', 'product', 'portable',
  'accessories', 'devices', 'tools', 'care', 'storage', 'repair', 'lighting',
]);

const proposalTokens = (value: string): string[] => normalizeText(value)
  .split(' ')
  .filter((token) => token.length >= 4 && !PROPOSAL_STOP_WORDS.has(token));

const tokenMatches = (evidence: string, token: string): boolean => {
  const singular = token.endsWith('s') ? token.slice(0, -1) : token;
  return evidence.split(' ').some((candidate) => candidate === token || candidate === singular || candidate.startsWith(`${singular}-`));
};

const evidenceFor = (input: SuggestZyroCategoryInput): EvidenceFields => ({
  title: normalizeText([input.productName, input.productType, input.model].filter(Boolean).join(' ')),
  description: normalizeText(input.description),
  metadata: normalizeText([
    input.brand,
    ...(input.keywords || []),
    ...Object.entries(input.specifications || {}).flatMap(([key, value]) => [key, String(value ?? '')]),
  ].filter(Boolean).join(' ')),
});

const missingTaxonomyProposalFor = (
  evidence: EvidenceFields,
  proposals: readonly ZyroTaxonomyProposal[] | undefined,
): ZyroMissingTaxonomyProposal | null => {
  if (!proposals || proposals.length === 0) return null;
  const ranked = proposals
    .filter((proposal) => proposal.status !== 'REJECTED' && !proposal.collision)
    .map((proposal) => {
      const terms = proposalTokens(proposal.proposedLabel);
      const titleMatches = terms.filter((term) => tokenMatches(evidence.title, term));
      const descriptionMatches = terms.filter((term) => tokenMatches(evidence.description, term));
      const metadataMatches = terms.filter((term) => tokenMatches(evidence.metadata, term));
      const phraseMatch = phraseInText(evidence.title, proposal.proposedLabel);
      const score = (titleMatches.length * 4) + (descriptionMatches.length * 2) + metadataMatches.length + (phraseMatch ? 6 : 0);
      return { proposal, titleMatches, descriptionMatches, metadataMatches, phraseMatch, score };
    })
    .filter((candidate) => candidate.score > 0 && (candidate.phraseMatch || candidate.titleMatches.length >= 2))
    .sort((left, right) => right.score - left.score || left.proposal.proposalId.localeCompare(right.proposal.proposalId));
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || (runnerUp && best.score === runnerUp.score)) return null;
  const evidenceReasons = [
    ...best.titleMatches.map((term) => `Matched "${term}" in product name`),
    ...best.descriptionMatches.map((term) => `Matched "${term}" in description`),
    ...best.metadataMatches.map((term) => `Matched "${term}" in product metadata`),
  ].slice(0, 3);
  if (evidenceReasons.length === 0) return null;
  return {
    kind: best.proposal.parentActive ? 'missing_subcategory' : 'missing_category',
    proposal: best.proposal,
    confidence: 'MEDIUM',
    evidence: evidenceReasons,
    creationSupported: best.proposal.parentActive && !best.proposal.collision,
  };
};

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
  const proposalSuggestion = (): ZyroCategorySuggestion => {
    const missingTaxonomyProposal = missingTaxonomyProposalFor(evidence, input.taxonomyProposals);
    return missingTaxonomyProposal
      ? {
        ...noMatch(),
        status: 'MISSING_TAXONOMY_PROPOSAL',
        confidence: missingTaxonomyProposal.confidence,
        reasons: missingTaxonomyProposal.evidence,
        missingTaxonomyProposal,
      }
      : noMatch();
  };

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
  if (!best) return proposalSuggestion();
  const runnerUp = ranked[1];
  const lead = runnerUp ? best.score - runnerUp.score : best.score;
  if (best.score < 5 || (runnerUp && lead === 0) || !best.hasRequiredSubcategory) return proposalSuggestion();

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
