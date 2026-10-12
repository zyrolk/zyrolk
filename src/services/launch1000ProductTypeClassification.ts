export const LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_MANIFEST_REVISION = 'launch1000-final800-visual-freeze-r1';

export const LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_ALLOWLIST = {
  'dropex-adl0019': 'tool or hardware',
  'dropex-aju0010': 'audio device',
  'dropex-aju0013': 'audio device',
  'dropex-aju0021': 'audio device',
  'dropex-aju0027': 'household product',
  'dropex-ajuch-3338': 'household product',
} as const;

export const LAUNCH1000_PRODUCT_TYPE_EVIDENCE_GUIDANCE = {
  'dropex-adl0019': 'Title or description must identify cabinet jack support hardware.',
  'dropex-aju0010': 'Title or description must identify a subwoofer.',
  'dropex-aju0013': 'Title or description must identify earbuds.',
  'dropex-aju0021': 'Title or description must identify earbuds.',
  'dropex-aju0027': 'Title or description must identify a cleaning brush.',
  'dropex-ajuch-3338': 'Title or description must identify a clothes rack.',
} as const;

export type Launch1000ProductTypeClassificationEvidenceKind = 'product_title' | 'product_description' | 'managed_image';

export interface Launch1000ProductTypeClassificationEvidenceReference {
  kind: Launch1000ProductTypeClassificationEvidenceKind;
  ref: string;
}

export interface Launch1000ProductTypeClassificationDecision {
  decision: 'approve';
  confirmed: true;
  manifestRevision: string;
  productType: string;
  evidence: Launch1000ProductTypeClassificationEvidenceReference[];
  rationale: string;
}

export const launch1000ProductTypeCandidate = (productId: string): string | null => (
  LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_ALLOWLIST[productId as keyof typeof LAUNCH1000_PRODUCT_TYPE_CLASSIFICATION_ALLOWLIST] || null
);

export const launch1000ProductTypeEvidenceGuidance = (productId: string): string => (
  LAUNCH1000_PRODUCT_TYPE_EVIDENCE_GUIDANCE[productId as keyof typeof LAUNCH1000_PRODUCT_TYPE_EVIDENCE_GUIDANCE] || 'Select clear title or description evidence; managed images are supplementary only.'
);
