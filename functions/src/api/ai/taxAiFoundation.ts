import { createHash } from "node:crypto";

import {
  isCanonicalActiveCategory,
  normalizeSupplierMappingValue,
  type StoreCategoryMappingCandidate,
  type SupplierCategoryMappingRecord,
} from "../suppliers/supplierProductMapping";

export const TAX_AI_SCHEMA_VERSION = "tax-ai-1" as const;

export type TaxAiDecision = "HIGH_CONFIDENCE" | "REVIEW" | "NO_MATCH" | "POLICY_HOLD";
export type TaxAiResultGroup = "HIGH_CONFIDENCE" | "REVIEW" | "NO_MATCH" | "POLICY_HOLD" | "ERROR";

export interface TaxAiTaxonomyCandidate {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly subcategoryId: string | null;
  readonly subcategoryName?: string;
}

export interface TaxAiEvidenceItem {
  readonly source: "title" | "description" | "product_type" | "features" | "specifications" | "supplier_taxonomy" | "managed_image" | "deterministic";
  readonly detail: string;
}

export interface TaxAiManagedImageReference {
  readonly url: string;
  readonly provenance: "zyro-managed";
  readonly publicationSafe: true;
  readonly storagePath: string;
  readonly imageStatus: "ready" | "published";
}

export interface TaxAiProductEvidence {
  readonly sourceId: string;
  readonly supplierSku: string;
  readonly title: string;
  readonly description?: string;
  readonly productType?: string;
  readonly features?: readonly string[];
  readonly specifications?: Readonly<Record<string, unknown>>;
  readonly supplierTaxonomy?: readonly string[];
  readonly managedPrimaryImage?: TaxAiManagedImageReference;
}

export interface TaxAiTaxonomyAssessment {
  readonly categoryId: string | null;
  readonly subcategoryId: string | null;
  readonly confidence: number;
  readonly alternateCandidates: readonly TaxAiTaxonomyCandidate[];
  readonly needsNewTaxonomy: boolean;
  readonly proposedTaxonomy?: {
    readonly categoryName?: string;
    readonly subcategoryName?: string;
    readonly reason?: string;
  };
  readonly evidence: readonly TaxAiEvidenceItem[];
}

export interface TaxAiRiskAssessment {
  readonly policyReviewRequired: boolean;
  readonly flags: readonly string[];
}

export interface TaxAiClassification {
  readonly taxonomy: TaxAiTaxonomyAssessment;
  readonly risk: TaxAiRiskAssessment;
  readonly decision: TaxAiDecision;
  readonly reasons: readonly string[];
  readonly model?: string;
  readonly promptVersion: typeof TAX_AI_SCHEMA_VERSION;
  readonly schemaVersion: typeof TAX_AI_SCHEMA_VERSION;
}

export interface TaxAiValidationResult {
  readonly valid: boolean;
  readonly category?: TaxAiTaxonomyCandidate;
  readonly subcategoryRequired?: boolean;
  readonly reason?: string;
}

export interface TaxAiDeterministicResolution {
  readonly taxonomy: TaxAiTaxonomyAssessment;
  readonly source: "trusted_mapping" | "product_evidence" | "unresolved";
}

export interface TaxAiTaxonomyCatalog {
  readonly categories: readonly StoreCategoryMappingCandidate[];
  readonly fingerprint?: string;
}

const MAX_TEXT_LENGTH = 4_000;
const RISK_RULES: readonly { readonly flag: string; readonly pattern: RegExp }[] = Object.freeze([
  { flag: "WEAPON_OR_BLADE_REVIEW", pattern: /\b(knife|knives|sword|weapon|firearm|gun|ammunition|dagger|machete|blade)\b/iu },
  { flag: "MEDICINE_OR_REGULATED_HEALTH_REVIEW", pattern: /\b(medicine|medication|tablet|capsule|antibiotic|prescription|injection|pharmaceutical)\b/iu },
  { flag: "CHEMICAL_OR_HAZARDOUS_REVIEW", pattern: /\b(pesticide|herbicide|poison|bleach|acid|solvent|flammable|corrosive|chemical)\b/iu },
  { flag: "ADULT_OR_RESTRICTED_REVIEW", pattern: /\b(adult|erotic|sex toy|pornographic|explicit)\b/iu },
  { flag: "AUTHENTICITY_OR_COUNTERFEIT_REVIEW", pattern: /\b(counterfeit|fake|replica|1:1|mirror quality|unauthorized copy)\b/iu },
  { flag: "TOBACCO_OR_VAPING_REVIEW", pattern: /\b(tobacco|cigarette|vape|vaping|nicotine)\b/iu },
]);

const asTrimmedString = (value: unknown, maxLength = MAX_TEXT_LENGTH): string => (
  typeof value === "string" ? value.normalize("NFKC").trim().slice(0, maxLength) : ""
);

const asStringArray = (value: unknown, maxItems = 50): string[] => (
  Array.isArray(value)
    ? value.map((item) => asTrimmedString(item, 1_000)).filter(Boolean).slice(0, maxItems)
    : []
);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const clampConfidence = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const activeSubcategories = (category: StoreCategoryMappingCandidate) => (
  (category.subcategories || []).filter((subcategory) => subcategory.isActive !== false && subcategory.taxonomyCandidate !== true)
);

export function activeTaxonomyCandidates(catalog: TaxAiTaxonomyCatalog): readonly TaxAiTaxonomyCandidate[] {
  const result: TaxAiTaxonomyCandidate[] = [];
  catalog.categories.filter(isCanonicalActiveCategory).forEach((category) => {
    const subcategories = activeSubcategories(category);
    if (subcategories.length === 0) {
      result.push({ categoryId: category.id, categoryName: category.name, subcategoryId: null });
      return;
    }
    subcategories.forEach((subcategory) => result.push({
      categoryId: category.id,
      categoryName: category.name,
      subcategoryId: subcategory.id,
      subcategoryName: subcategory.name,
    }));
  });
  return Object.freeze(result);
}

export function validateTaxAiTaxonomySelection(
  selection: Pick<TaxAiTaxonomyAssessment, "categoryId" | "subcategoryId">,
  catalog: TaxAiTaxonomyCatalog,
): TaxAiValidationResult {
  const categoryId = asTrimmedString(selection.categoryId);
  const subcategoryId = asTrimmedString(selection.subcategoryId);
  if (!categoryId) return { valid: false, reason: "CATEGORY_UNRESOLVED" };
  const category = catalog.categories.find((candidate) => candidate.id === categoryId);
  if (!category || !isCanonicalActiveCategory(category)) return { valid: false, reason: "INVALID_OR_INACTIVE_CATEGORY" };
  const subcategories = activeSubcategories(category);
  const required = subcategories.length > 0;
  if (required && !subcategoryId) return { valid: false, subcategoryRequired: true, reason: "SUBCATEGORY_REQUIRED" };
  if (subcategoryId) {
    const subcategory = subcategories.find((candidate) => candidate.id === subcategoryId);
    if (!subcategory) return { valid: false, subcategoryRequired: required, reason: "INVALID_OR_INACTIVE_SUBCATEGORY" };
    return {
      valid: true,
      subcategoryRequired: required,
      category: {
        categoryId: category.id,
        categoryName: category.name,
        subcategoryId: subcategory.id,
        subcategoryName: subcategory.name,
      },
    };
  }
  return {
    valid: true,
    subcategoryRequired: false,
    category: { categoryId: category.id, categoryName: category.name, subcategoryId: null },
  };
}

function normalizeEvidenceText(evidence: TaxAiProductEvidence): string {
  return normalizeSupplierMappingValue([
    evidence.title,
    evidence.description || "",
    evidence.productType || "",
    ...(evidence.features || []),
    ...Object.entries(evidence.specifications || {}).flatMap(([key, value]) => [key, String(value || "")]),
  ].join(" "));
}

export function normalizeTaxAiEvidence(input: TaxAiProductEvidence): TaxAiProductEvidence {
  return Object.freeze({
    sourceId: asTrimmedString(input.sourceId, 200),
    supplierSku: asTrimmedString(input.supplierSku, 200),
    title: asTrimmedString(input.title),
    ...(asTrimmedString(input.description) ? { description: asTrimmedString(input.description) } : {}),
    ...(asTrimmedString(input.productType, 500) ? { productType: asTrimmedString(input.productType, 500) } : {}),
    ...(asStringArray(input.features).length > 0 ? { features: Object.freeze(asStringArray(input.features)) } : {}),
    ...(Object.keys(asRecord(input.specifications)).length > 0 ? { specifications: Object.freeze({ ...asRecord(input.specifications) }) } : {}),
    ...(asStringArray(input.supplierTaxonomy, 10).length > 0 ? { supplierTaxonomy: Object.freeze(asStringArray(input.supplierTaxonomy, 10)) } : {}),
    ...(isSafeManagedImageReference(input.managedPrimaryImage) ? { managedPrimaryImage: Object.freeze({ ...input.managedPrimaryImage }) } : {}),
  });
}

export function isSafeManagedImageReference(value: unknown): value is TaxAiManagedImageReference {
  const candidate = asRecord(value);
  let hostname = "";
  try { hostname = new URL(String(candidate.url || "")).hostname.toLowerCase(); } catch { return false; }
  return candidate.provenance === "zyro-managed"
    && candidate.publicationSafe === true
    && typeof candidate.url === "string"
    && /^https:\/\//iu.test(candidate.url.trim())
    && ["firebasestorage.googleapis.com", "storage.googleapis.com"].includes(hostname)
    && typeof candidate.storagePath === "string"
    && candidate.storagePath.trim().length > 0
    && ["ready", "published"].includes(String(candidate.imageStatus))
    && !/[?&](?:x-goog-|token|signature|expires|exp|X-Amz-)/iu.test(candidate.url);
}

export function hashTaxAiEvidence(evidence: TaxAiProductEvidence, taxonomyFingerprint = ""): string {
  const normalized = normalizeTaxAiEvidence(evidence);
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: TAX_AI_SCHEMA_VERSION, taxonomyFingerprint, evidence: normalized }), "utf8")
    .digest("hex");
}

export function assessProductRisk(evidence: TaxAiProductEvidence): TaxAiRiskAssessment {
  const text = [
    evidence.title,
    evidence.description || "",
    evidence.productType || "",
    ...(evidence.features || []),
    ...Object.values(evidence.specifications || {}).map((value) => String(value || "")),
  ].join(" ");
  const flags = RISK_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.flag);
  return Object.freeze({ policyReviewRequired: flags.length > 0, flags: Object.freeze(flags) });
}

function emptyTaxonomyAssessment(overrides: Partial<TaxAiTaxonomyAssessment> = {}): TaxAiTaxonomyAssessment {
  return {
    categoryId: null,
    subcategoryId: null,
    confidence: 0,
    alternateCandidates: Object.freeze([]),
    needsNewTaxonomy: false,
    evidence: Object.freeze([]),
    ...overrides,
  };
}

export function safeTaxAiReview(reason: string, model?: string, promptVersion: typeof TAX_AI_SCHEMA_VERSION = TAX_AI_SCHEMA_VERSION): TaxAiClassification {
  return Object.freeze({
    taxonomy: emptyTaxonomyAssessment(),
    risk: Object.freeze({ policyReviewRequired: false, flags: Object.freeze([]) }),
    decision: "REVIEW",
    reasons: Object.freeze([reason]),
    ...(model ? { model } : {}),
    promptVersion,
    schemaVersion: TAX_AI_SCHEMA_VERSION,
  });
}

function canonicalMappingIsTrusted(mapping: SupplierCategoryMappingRecord): boolean {
  return ["manual", "learned"].includes(mapping.mappingType)
    && Boolean(asTrimmedString(mapping.updatedBy, 200))
    && Number.isFinite(mapping.version)
    && mapping.version > 0;
}

function trustedMappingResolution(
  evidence: TaxAiProductEvidence,
  catalog: TaxAiTaxonomyCatalog,
  mappings: readonly SupplierCategoryMappingRecord[],
): TaxAiDeterministicResolution | null {
  const supplierCategory = evidence.supplierTaxonomy?.[0] || "";
  const normalizedCategory = normalizeSupplierMappingValue(supplierCategory);
  if (!normalizedCategory) return null;
  const mapping = mappings
    .filter(canonicalMappingIsTrusted)
    .filter((candidate) => candidate.sourceId === evidence.sourceId || ["*", "global"].includes(candidate.sourceId))
    .find((candidate) => normalizeSupplierMappingValue(candidate.normalizedCategory || candidate.supplierCategory) === normalizedCategory);
  if (!mapping) return null;
  const validation = validateTaxAiTaxonomySelection({ categoryId: mapping.targetCategoryId, subcategoryId: mapping.targetSubcategoryId }, catalog);
  if (!validation.valid || !validation.category) return null;
  return {
    source: "trusted_mapping",
    taxonomy: emptyTaxonomyAssessment({
      categoryId: validation.category.categoryId,
      subcategoryId: validation.category.subcategoryId,
      confidence: 1,
      evidence: Object.freeze([{ source: "deterministic", detail: "Approved trusted supplier taxonomy mapping." }]),
    }),
  };
}

function productEvidenceResolution(evidence: TaxAiProductEvidence, catalog: TaxAiTaxonomyCatalog): TaxAiDeterministicResolution | null {
  const productText = normalizeEvidenceText(evidence);
  if (!productText) return null;
  const titleText = normalizeSupplierMappingValue(evidence.title);
  const candidates = activeTaxonomyCandidates(catalog)
    .map((candidate) => {
      const categoryEvidence = [candidate.categoryName, ...(catalog.categories.find((category) => category.id === candidate.categoryId)?.keywords || [])]
        .map(normalizeSupplierMappingValue)
        .filter(Boolean);
      const subcategoryEvidence = candidate.subcategoryName ? normalizeSupplierMappingValue(candidate.subcategoryName) : "";
      const categoryTitleMatch = categoryEvidence.some((signal) => Boolean(signal && ` ${titleText} `.includes(` ${signal} `)));
      const categoryBodyMatch = categoryEvidence.some((signal) => Boolean(signal && ` ${productText} `.includes(` ${signal} `)));
      const subcategoryMatch = Boolean(subcategoryEvidence && ` ${productText} `.includes(` ${subcategoryEvidence} `));
      const score = (categoryTitleMatch ? 0.8 : 0) + (categoryBodyMatch ? 0.15 : 0) + (subcategoryMatch ? 0.05 : 0);
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.candidate.categoryId.localeCompare(right.candidate.categoryId) || String(left.candidate.subcategoryId).localeCompare(String(right.candidate.subcategoryId)));
  const best = candidates[0];
  if (!best || best.score < 0.8) return null;
  const tied = candidates.filter((candidate) => candidate.score === best.score);
  if (tied.length > 1) return null;
  return {
    source: "product_evidence",
    taxonomy: emptyTaxonomyAssessment({
      categoryId: best.candidate.categoryId,
      subcategoryId: best.candidate.subcategoryId,
      confidence: best.score,
      evidence: Object.freeze([{ source: "deterministic", detail: "Zyro-owned product title/evidence matched an active taxonomy candidate." }]),
    }),
  };
}

export function resolveTaxAiDeterministicTaxonomy(input: {
  evidence: TaxAiProductEvidence;
  catalog: TaxAiTaxonomyCatalog;
  trustedMappings?: readonly SupplierCategoryMappingRecord[];
}): TaxAiDeterministicResolution {
  const evidence = normalizeTaxAiEvidence(input.evidence);
  const trusted = trustedMappingResolution(evidence, input.catalog, input.trustedMappings || []);
  if (trusted) return trusted;
  const product = productEvidenceResolution(evidence, input.catalog);
  if (product) return product;
  return {
    source: "unresolved",
    taxonomy: emptyTaxonomyAssessment({
      needsNewTaxonomy: true,
      evidence: Object.freeze([
        ...(evidence.supplierTaxonomy?.length ? [{ source: "supplier_taxonomy" as const, detail: "Supplier taxonomy retained only as a secondary clue." }] : []),
        { source: "deterministic" as const, detail: "No unique active Zyro taxonomy was resolved from product-owned evidence." },
      ]),
      proposedTaxonomy: { reason: "No suitable existing active taxonomy was proven." },
    }),
  };
}

function validAlternates(value: unknown, catalog: TaxAiTaxonomyCatalog): TaxAiTaxonomyCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = asRecord(candidate);
    const validation = validateTaxAiTaxonomySelection({ categoryId: item.categoryId as string, subcategoryId: item.subcategoryId as string }, catalog);
    return validation.valid && validation.category ? [validation.category] : [];
  });
}

export function validateTaxAiModelOutput(input: {
  raw: unknown;
  catalog: TaxAiTaxonomyCatalog;
  evidence: TaxAiProductEvidence;
  model?: string;
  promptVersion?: typeof TAX_AI_SCHEMA_VERSION;
  minimumHighConfidence?: number;
}): TaxAiClassification {
  const raw = asRecord(input.raw);
  const rawTaxonomy = asRecord(raw.taxonomy);
  const rawRisk = asRecord(raw.risk);
  const rawDecision = asTrimmedString(raw.decision, 50) as TaxAiDecision;
  const validDecision: TaxAiDecision = ["HIGH_CONFIDENCE", "REVIEW", "NO_MATCH", "POLICY_HOLD"].includes(rawDecision)
    ? rawDecision
    : "REVIEW";
  const categoryId = asTrimmedString(rawTaxonomy.categoryId, 200) || null;
  const subcategoryId = asTrimmedString(rawTaxonomy.subcategoryId, 200) || null;
  const taxonomyValidation = validateTaxAiTaxonomySelection({ categoryId, subcategoryId }, input.catalog);
  const modelFlags = asStringArray(rawRisk.flags, 20);
  const deterministicRisk = assessProductRisk(input.evidence);
  const flags = [...new Set([...modelFlags, ...deterministicRisk.flags])];
  const risk = Object.freeze({ policyReviewRequired: flags.length > 0 || rawRisk.policyReviewRequired === true, flags: Object.freeze(flags) });
  const reasons = asStringArray(raw.reasons, 20);
  const evidence = asStringArray(rawTaxonomy.evidence, 20).map((detail) => ({ source: "deterministic" as const, detail }));
  const selected = taxonomyValidation.valid && taxonomyValidation.category ? taxonomyValidation.category : undefined;
  const confidence = clampConfidence(rawTaxonomy.confidence);
  const minimum = input.minimumHighConfidence;
  const thresholdAllowsHigh = minimum === undefined || (Number.isFinite(minimum) && confidence >= minimum);
  let decision: TaxAiDecision = validDecision;
  if (risk.policyReviewRequired) decision = "POLICY_HOLD";
  else if (!selected) decision = validDecision === "NO_MATCH" ? "NO_MATCH" : "REVIEW";
  else if (decision === "HIGH_CONFIDENCE" && !thresholdAllowsHigh) decision = "REVIEW";
  const selectionReasons = [
    ...reasons,
    ...(taxonomyValidation.reason && taxonomyValidation.reason !== "CATEGORY_UNRESOLVED" ? [taxonomyValidation.reason] : []),
    ...(risk.flags.length > 0 ? risk.flags : []),
  ];
  return Object.freeze({
    taxonomy: emptyTaxonomyAssessment({
      categoryId: selected?.categoryId || null,
      subcategoryId: selected?.subcategoryId || null,
      confidence,
      alternateCandidates: Object.freeze(validAlternates(rawTaxonomy.alternateCandidates, input.catalog)),
      needsNewTaxonomy: rawTaxonomy.needsNewTaxonomy === true || (!selected && validDecision === "NO_MATCH"),
      ...(rawTaxonomy.proposedTaxonomy && typeof rawTaxonomy.proposedTaxonomy === "object" ? { proposedTaxonomy: {
        categoryName: asTrimmedString(asRecord(rawTaxonomy.proposedTaxonomy).categoryName, 200) || undefined,
        subcategoryName: asTrimmedString(asRecord(rawTaxonomy.proposedTaxonomy).subcategoryName, 200) || undefined,
        reason: asTrimmedString(asRecord(rawTaxonomy.proposedTaxonomy).reason, 500) || undefined,
      } } : {}),
      evidence: Object.freeze(evidence),
    }),
    risk,
    decision,
    reasons: Object.freeze([...new Set(selectionReasons)]),
    ...(input.model ? { model: input.model } : {}),
    promptVersion: input.promptVersion || TAX_AI_SCHEMA_VERSION,
    schemaVersion: TAX_AI_SCHEMA_VERSION,
  });
}

export function resultGroup(classification: TaxAiClassification): TaxAiResultGroup {
  return classification.decision;
}

export function taxonomyFingerprint(catalog: TaxAiTaxonomyCatalog): string {
  return createHash("sha256")
    .update(JSON.stringify(activeTaxonomyCandidates(catalog)), "utf8")
    .digest("hex");
}

export interface TaxAiBenchmarkReference {
  readonly id: string;
  readonly evidence: TaxAiProductEvidence;
  readonly expectedCategoryId: string;
  readonly expectedSubcategoryId: string | null;
  readonly expectedPolicyReview?: boolean;
}

export interface TaxAiBenchmarkObservation {
  readonly id: string;
  readonly classification: TaxAiClassification;
}

export interface TaxAiBenchmarkMetrics {
  readonly total: number;
  readonly categoryTop1Accuracy: number;
  readonly subcategoryTop1Accuracy: number | null;
  readonly highConfidenceCoverage: number;
  readonly highConfidenceFalsePositiveRate: number;
  readonly reviewAbstentionRate: number;
  readonly invalidIdRate: number;
  readonly policyRiskFalsePositiveRate: number | null;
}

export function benchmarkTaxAiResults(
  references: readonly TaxAiBenchmarkReference[],
  observations: readonly TaxAiBenchmarkObservation[],
): TaxAiBenchmarkMetrics {
  const byId = new Map(observations.map((observation) => [observation.id, observation.classification]));
  let categoryCorrect = 0;
  let subcategoryTotal = 0;
  let subcategoryCorrect = 0;
  let highConfidence = 0;
  let highConfidenceWrong = 0;
  let abstained = 0;
  let invalidIds = 0;
  let riskFalsePositive = 0;
  let riskInspectable = 0;
  for (const reference of references) {
    const classification = byId.get(reference.id);
    if (!classification) continue;
    const categoryCorrectForReference = classification.taxonomy.categoryId === reference.expectedCategoryId;
    if (categoryCorrectForReference) categoryCorrect += 1;
    if (reference.expectedSubcategoryId !== null) {
      subcategoryTotal += 1;
      if (classification.taxonomy.subcategoryId === reference.expectedSubcategoryId) subcategoryCorrect += 1;
    }
    if (classification.decision === "HIGH_CONFIDENCE") {
      highConfidence += 1;
      if (!categoryCorrectForReference || (reference.expectedSubcategoryId !== null && classification.taxonomy.subcategoryId !== reference.expectedSubcategoryId)) highConfidenceWrong += 1;
    }
    if (classification.decision === "REVIEW" || classification.decision === "NO_MATCH" || classification.decision === "POLICY_HOLD") abstained += 1;
    if (classification.reasons.some((reason) => reason.includes("INVALID_OR_INACTIVE"))) invalidIds += 1;
    if (reference.expectedPolicyReview !== undefined) {
      riskInspectable += 1;
      if (classification.risk.policyReviewRequired !== reference.expectedPolicyReview) riskFalsePositive += 1;
    }
  }
  const total = references.length;
  return Object.freeze({
    total,
    categoryTop1Accuracy: total ? categoryCorrect / total : 0,
    subcategoryTop1Accuracy: subcategoryTotal ? subcategoryCorrect / subcategoryTotal : null,
    highConfidenceCoverage: total ? highConfidence / total : 0,
    highConfidenceFalsePositiveRate: highConfidence ? highConfidenceWrong / highConfidence : 0,
    reviewAbstentionRate: total ? abstained / total : 0,
    invalidIdRate: total ? invalidIds / total : 0,
    policyRiskFalsePositiveRate: riskInspectable ? riskFalsePositive / riskInspectable : null,
  });
}

export function buildHiddenTaxAiBenchmarkReference(input: {
  id: string;
  evidence: TaxAiProductEvidence;
  canonicalCategoryId: string;
  canonicalSubcategoryId?: string | null;
  expectedPolicyReview?: boolean;
}): TaxAiBenchmarkReference {
  const evidence = normalizeTaxAiEvidence(input.evidence);
  return Object.freeze({
    id: asTrimmedString(input.id, 200),
    evidence,
    expectedCategoryId: asTrimmedString(input.canonicalCategoryId, 200),
    expectedSubcategoryId: asTrimmedString(input.canonicalSubcategoryId, 200) || null,
    ...(input.expectedPolicyReview === undefined ? {} : { expectedPolicyReview: input.expectedPolicyReview }),
  });
}
