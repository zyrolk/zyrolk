import { createHash } from "node:crypto";
import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { isCanonicalActiveCategory } from "../suppliers/supplierProductMapping";
import {
  Launch1000ManifestSnapshot,
  Launch1000TaxonomyProposal,
  launch1000ParentRuleFingerprint,
  launch1000RecordFingerprint,
  loadLaunch1000Snapshot,
} from "./launch1000Snapshot";

export const LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION = "launch1000_taxonomy_proposals";
export const LAUNCH1000_TAXONOMY_AUDIT_COLLECTION = "launch1000_taxonomy_audit";
const PARENT_CATEGORY_PROPOSAL_REVISION = "parent-category-r1";
const CATEGORY_SCAN_LIMIT = 1001;

export type Launch1000TaxonomyGovernanceStatus = "PENDING_ADMIN_APPROVAL" | "APPROVED" | "CREATED" | "REJECTED";

export interface Launch1000Operator {
  uid: string;
  email: string;
}

export interface Launch1000TaxonomyGovernanceRecord {
  proposalId: string;
  proposalRevision: string;
  status: Launch1000TaxonomyGovernanceStatus;
  parentCategoryId: string;
  proposedLabel: string;
  proposedSlug: string;
  parentRuleFingerprint?: string;
  createdSubcategoryId?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface Launch1000ParentCategoryProposalInput {
  queueItemId: string;
  expectedPendingRevision: string;
  expectedUpdatedAt: string;
  expectedFingerprint: string;
  proposedName: string;
  proposedSlug: string;
  proposedSubcategoryName: string;
  proposedSubcategorySlug: string;
  evidenceRefs: string[];
  adminConfirmed: true;
}

export interface Launch1000ParentCategoryProposalResult {
  proposalId: string;
  proposalRevision: string;
  status: "APPROVED" | "CREATED";
  idempotent?: boolean;
  createdCategoryId?: string;
  createdSubcategoryId?: string;
}

interface ParentSourceEvidenceOption {
  kind: "product_title" | "product_description";
  ref: string;
  value: string;
}

interface ParentSourceEvidence {
  options: ParentSourceEvidenceOption[];
  title: string;
  description: string;
}

interface ParentCategoryGovernanceRecord {
  proposalId: string;
  proposalRevision: string;
  status: Launch1000TaxonomyGovernanceStatus;
  queueItemId: string;
  expectedPendingRevision: string;
  expectedUpdatedAt: string;
  expectedFingerprint: string;
  sourceFingerprint: string;
  evidenceFingerprint: string;
  evidenceRefs: string[];
  proposedName: string;
  proposedSlug: string;
  proposedSubcategoryName: string;
  proposedSubcategorySlug: string;
  approvedBy?: string;
  approvedEmail?: string;
  approvedAt?: string;
  createdBy?: string;
  createdEmail?: string;
  createdAt?: string;
  createdCategoryId?: string;
  createdSubcategoryId?: string;
}

const text = (value: unknown, field: string, max = 200): string => {
  if (typeof value !== "string") throw new ApiError(`Launch-1000 ${field} is invalid.`, 400);
  const result = value.trim();
  if (!result || result.length > max || result.includes("/")) throw new ApiError(`Launch-1000 ${field} is invalid.`, 400);
  return result;
};

const proposalIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 26) {
    throw new ApiError("Select between one and 26 Launch-1000 taxonomy proposals.", 400);
  }
  const ids = value.map((item) => text(item, "proposal ID", 160));
  if (new Set(ids).size !== ids.length) throw new ApiError("Launch-1000 proposal IDs must be unique.", 400);
  return ids.sort();
};

const proposalFor = (snapshot: Launch1000ManifestSnapshot, proposalId: string, revision: string): Launch1000TaxonomyProposal => {
  const proposal = snapshot.taxonomyProposals.find((item) => item.proposalId === proposalId);
  if (!proposal) throw new ApiError("Launch-1000 taxonomy proposal was not found in the checked-in snapshot.", 404);
  if (proposal.revision !== revision) throw new ApiError("Launch-1000 taxonomy proposal revision is stale.", 409);
  return proposal;
};

const activeSubcategories = (category: Record<string, unknown>): Record<string, unknown>[] => (
  Array.isArray(category.subcategories)
    ? category.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)) && (entry as Record<string, unknown>).isActive === true && (entry as Record<string, unknown>).taxonomyCandidate !== true)
    : []
);

const normalized = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();

const readGovernance = (value: unknown): Launch1000TaxonomyGovernanceRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (!["PENDING_ADMIN_APPROVAL", "APPROVED", "CREATED", "REJECTED"].includes(String(status))) return null;
  return {
    proposalId: String(record.proposalId || ""),
    proposalRevision: String(record.proposalRevision || ""),
    status: status as Launch1000TaxonomyGovernanceStatus,
    parentCategoryId: String(record.parentCategoryId || ""),
    proposedLabel: String(record.proposedLabel || ""),
    proposedSlug: String(record.proposedSlug || ""),
    ...(record.parentRuleFingerprint ? { parentRuleFingerprint: String(record.parentRuleFingerprint) } : {}),
    ...(record.createdSubcategoryId ? { createdSubcategoryId: String(record.createdSubcategoryId) } : {}),
    ...(record.approvedBy ? { approvedBy: String(record.approvedBy) } : {}),
    ...(record.approvedAt ? { approvedAt: String(record.approvedAt) } : {}),
    ...(record.createdBy ? { createdBy: String(record.createdBy) } : {}),
    ...(record.createdAt ? { createdAt: String(record.createdAt) } : {}),
  };
};

const governanceReference = (db: Firestore, proposalId: string) => (
  db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(proposalId)
);

const validateParent = (proposal: Launch1000TaxonomyProposal, categoryData: Record<string, unknown> | undefined): void => {
  if (!categoryData || !isCanonicalActiveCategory(categoryData)) {
    throw new ApiError("Launch-1000 proposal parent must be an active canonical category.", 409);
  }
  const hasEquivalent = activeSubcategories(categoryData).some((subcategory) => (
    normalized(String(subcategory.name || "")) === normalized(proposal.proposedLabel)
      || normalized(String(subcategory.slug || "")) === normalized(proposal.proposedSlug)
  ));
  if (hasEquivalent) throw new ApiError("An equivalent active subcategory already exists under this parent.", 409);
};

const projectPreview = (
  proposal: Launch1000TaxonomyProposal,
  categoryData: Record<string, unknown> | undefined,
  governance: Launch1000TaxonomyGovernanceRecord | null,
) => ({
  proposalId: proposal.proposalId,
  revision: proposal.revision,
  parentCategoryLabel: proposal.parentCategoryLabel,
  proposedLabel: proposal.proposedLabel,
  proposedSlug: proposal.proposedSlug,
  label: proposal.proposedLabel,
  slug: proposal.proposedSlug,
  parentCategoryId: proposal.parentCategoryId,
  affectedFinalManifestCount: proposal.affectedFinalManifestCount,
  status: governance?.status || "PENDING_ADMIN_APPROVAL",
  createdSubcategoryId: governance?.createdSubcategoryId || null,
  parentActive: Boolean(categoryData && isCanonicalActiveCategory(categoryData)),
  parentRuleFingerprint: categoryData ? launch1000ParentRuleFingerprint(categoryData) : null,
  collision: categoryData ? activeSubcategories(categoryData).some((subcategory) => (
    normalized(String(subcategory.name || "")) === normalized(proposal.proposedLabel)
      || normalized(String(subcategory.slug || "")) === normalized(proposal.proposedSlug)
  )) : false,
});

export async function previewLaunch1000TaxonomyProposals(
  db: Firestore,
  input: { proposalIds: unknown; revision: unknown },
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{ revision: string; proposals: ReturnType<typeof projectPreview>[] }> {
  const revision = text(input.revision, "governance revision", 160);
  const ids = proposalIds(input.proposalIds);
  const proposals = ids.map((id) => proposalFor(snapshot, id, revision));
  const categories = await db.getAll(...proposals.map((proposal) => db.collection("categories").doc(proposal.parentCategoryId)));
  const governance = await db.getAll(...proposals.map((proposal) => governanceReference(db, proposal.proposalId)));
  return {
    revision,
    proposals: proposals.map((proposal, index) => projectPreview(
      proposal,
      categories[index].exists ? categories[index].data() : undefined,
      readGovernance(governance[index].exists ? governance[index].data() : null),
    )),
  };
}

/**
 * Returns the checked-in, bounded proposal catalog for the authenticated
 * Product Review UI. This is intentionally read-only; approval and creation
 * remain separate transactional operations below.
 */
export async function listLaunch1000TaxonomyProposals(
  db: Firestore,
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{ revision: string; proposals: ReturnType<typeof projectPreview>[] }> {
  return previewLaunch1000TaxonomyProposals(
    db,
    {
      proposalIds: snapshot.taxonomyProposals.map((proposal) => proposal.proposalId),
      revision: snapshot.taxonomyProposals[0]?.revision || "launch1000-taxonomy-r1",
    },
    snapshot,
  );
}

const governanceDocument = (
  proposal: Launch1000TaxonomyProposal,
  status: Launch1000TaxonomyGovernanceStatus,
  operator: Launch1000Operator,
  now: string,
  parentRuleFingerprint: string,
  extra: Record<string, unknown> = {},
) => ({
  proposalId: proposal.proposalId,
  proposalRevision: proposal.revision,
  status,
  parentCategoryId: proposal.parentCategoryId,
  proposedLabel: proposal.proposedLabel,
  proposedSlug: proposal.proposedSlug,
  affectedFinalManifestCount: proposal.affectedFinalManifestCount,
  parentRuleFingerprint,
  ...(status === "APPROVED" ? { approvedBy: operator.uid, approvedEmail: operator.email, approvedAt: now } : {}),
  ...(status === "CREATED" ? { createdBy: operator.uid, createdEmail: operator.email, createdAt: now } : {}),
  ...extra,
  updatedAt: now,
});

export async function approveLaunch1000TaxonomyProposal(
  db: Firestore,
  input: { proposalId: unknown; revision: unknown },
  operator: Launch1000Operator,
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{ proposalId: string; status: Launch1000TaxonomyGovernanceStatus; idempotent?: boolean }> {
  const revision = text(input.revision, "governance revision", 160);
  const proposalId = text(input.proposalId, "proposal ID", 160);
  const proposal = proposalFor(snapshot, proposalId, revision);
  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const parentReference = db.collection("categories").doc(proposal.parentCategoryId);
    const governanceRef = governanceReference(db, proposalId);
    const [parentSnapshot, governanceSnapshot] = await Promise.all([
      transaction.get(parentReference),
      transaction.get(governanceRef),
    ]);
    const parent = parentSnapshot.exists ? parentSnapshot.data() || {} : {};
    const current = readGovernance(governanceSnapshot.exists ? governanceSnapshot.data() : null);
    if (current?.proposalRevision && current.proposalRevision !== revision) throw new ApiError("Launch-1000 proposal revision conflict.", 409);
    if (current?.status === "CREATED") return { proposalId, status: "CREATED" as const, idempotent: true };
    if (current?.status === "APPROVED") return { proposalId, status: "APPROVED" as const, idempotent: true };
    if (current?.status === "REJECTED") throw new ApiError("The Launch-1000 taxonomy proposal is rejected.", 409);
    validateParent(proposal, parent);
    const parentRuleFingerprint = launch1000ParentRuleFingerprint(parent);
    transaction.set(governanceRef, governanceDocument(proposal, "APPROVED", operator, now, parentRuleFingerprint), { merge: true });
    const auditRef = db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).doc();
    transaction.create(auditRef, {
      id: auditRef.id,
      operation: "approve",
      proposalId,
      proposalRevision: revision,
      parentCategoryId: proposal.parentCategoryId,
      operatorUid: operator.uid,
      operatorEmail: operator.email,
      timestamp: now,
    });
    return { proposalId, status: "APPROVED" as const };
  });
}

export async function createApprovedLaunch1000TaxonomyProposal(
  db: Firestore,
  input: { proposalId: unknown; revision: unknown },
  operator: Launch1000Operator,
  snapshot: Launch1000ManifestSnapshot = loadLaunch1000Snapshot(),
): Promise<{ proposalId: string; status: "CREATED"; createdSubcategoryId: string; idempotent?: boolean }> {
  const revision = text(input.revision, "governance revision", 160);
  const proposalId = text(input.proposalId, "proposal ID", 160);
  const proposal = proposalFor(snapshot, proposalId, revision);
  const now = new Date().toISOString();
  const createdSubcategoryId = `launch1000-${proposal.proposedSlug}`;
  return db.runTransaction(async (transaction) => {
    const parentReference = db.collection("categories").doc(proposal.parentCategoryId);
    const governanceRef = governanceReference(db, proposalId);
    const [parentSnapshot, governanceSnapshot] = await Promise.all([
      transaction.get(parentReference),
      transaction.get(governanceRef),
    ]);
    if (!parentSnapshot.exists) throw new ApiError("Launch-1000 proposal parent category was not found.", 409);
    const parent = parentSnapshot.data() || {};
    const current = readGovernance(governanceSnapshot.exists ? governanceSnapshot.data() : null);
    if (!current || current.proposalRevision !== revision || !["APPROVED", "CREATED"].includes(current.status)) {
      throw new ApiError("Launch-1000 proposal must be explicitly approved before creation.", 409);
    }
    if (current.status === "CREATED") {
      if (current.createdSubcategoryId !== createdSubcategoryId) throw new ApiError("Launch-1000 created taxonomy identity conflicts.", 409);
      return { proposalId, status: "CREATED" as const, createdSubcategoryId, idempotent: true };
    }
    if (current.parentRuleFingerprint !== launch1000ParentRuleFingerprint(parent)) {
      throw new ApiError("The Launch-1000 parent specification rules changed after approval.", 409);
    }
    validateParent(proposal, parent);
    const subcategories = Array.isArray(parent.subcategories)
      ? parent.subcategories.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      : [];
    if (subcategories.some((entry) => String(entry.id || "") === createdSubcategoryId)) {
      throw new ApiError("The deterministic Launch-1000 taxonomy ID is already occupied.", 409);
    }
    const nextSubcategories = [...subcategories, {
      id: createdSubcategoryId,
      name: proposal.proposedLabel,
      slug: proposal.proposedSlug,
      isActive: true,
      taxonomyCandidate: false,
      taxonomyStatus: "active",
      launch1000ProposalId: proposalId,
      launch1000ProposalRevision: revision,
      createdAt: now,
      createdBy: operator.uid,
    }];
    transaction.update(parentReference, { subcategories: nextSubcategories, updatedAt: now });
    transaction.set(governanceRef, governanceDocument(proposal, "CREATED", operator, now, current.parentRuleFingerprint || "", {
      createdSubcategoryId,
    }), { merge: true });
    const auditRef = db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).doc();
    transaction.create(auditRef, {
      id: auditRef.id,
      operation: "create",
      proposalId,
      proposalRevision: revision,
      parentCategoryId: proposal.parentCategoryId,
      createdSubcategoryId,
      operatorUid: operator.uid,
      operatorEmail: operator.email,
      timestamp: now,
    });
    return { proposalId, status: "CREATED" as const, createdSubcategoryId };
  });
}

const parentStableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(parentStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${parentStableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

const parentHash = (value: unknown): string => createHash("sha256")
  .update(parentStableJson(value), "utf8")
  .digest("hex");

const parentNormalized = (value: string): string => value
  .normalize("NFKC")
  .trim()
  .toLocaleLowerCase("en")
  .replace(/&/gu, " and ")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const parentSlug = (value: string): string => parentNormalized(value)
  .replace(/\s+/gu, "-")
  .replace(/-+/gu, "-")
  .replace(/^-|-$/gu, "");

const parentText = (value: unknown, field: string, maxLength = 160): string => {
  if (typeof value !== "string") throw new ApiError(`Missing parent ${field} is invalid.`, 400);
  const result = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!result || result.length > maxLength || result.includes("/") || !/[\p{L}\p{N}]/u.test(result)) {
    throw new ApiError(`Missing parent ${field} is invalid.`, 400);
  }
  return result;
};

const optionalParentText = (value: unknown, field: string): string => {
  if (value === undefined || value === null || value === "") return "";
  return parentText(value, field, 120);
};

const parentSlugInput = (value: unknown, field: string): string => {
  const input = parentText(value, field, 120);
  const slug = parentSlug(input);
  if (!slug || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(slug)) {
    throw new ApiError(`Missing parent ${field} is invalid.`, 400);
  }
  return slug;
};

const parentHashInput = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value.trim().toLowerCase())) {
    throw new ApiError(`Missing parent ${field} is invalid.`, 400);
  }
  return value.trim().toLowerCase();
};

const parentTimestamp = (value: unknown, field: string): string => {
  const result = parentText(value, field, 80);
  if (!Number.isFinite(Date.parse(result))) throw new ApiError(`Missing parent ${field} is invalid.`, 400);
  return result;
};

const parentEvidenceRefs = (value: unknown): string[] => {
  const allowed = new Set([
    "supplierSnapshot.productPayload.name",
    "supplierSnapshot.productPayload.title",
    "supplierSnapshot.title",
    "supplierSnapshot.productPayload.description",
    "supplierSnapshot.description",
  ]);
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.size) {
    throw new ApiError("At least one supplier title or description evidence reference is required.", 400);
  }
  const refs = value.map((entry) => parentText(entry, "evidence reference", 120));
  if (new Set(refs).size !== refs.length || refs.some((ref) => !allowed.has(ref))) {
    throw new ApiError("Missing parent evidence references are invalid.", 400);
  }
  return refs.sort();
};

const parentInputFields = new Set([
  "queueItemId",
  "expectedPendingRevision",
  "expectedUpdatedAt",
  "expectedFingerprint",
  "proposedName",
  "proposedSlug",
  "proposedSubcategoryName",
  "proposedSubcategorySlug",
  "evidenceRefs",
  "adminConfirmed",
]);

const parseParentCategoryProposalInput = (value: unknown): Launch1000ParentCategoryProposalInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Missing parent category proposal is invalid.", 400);
  }
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((field) => !parentInputFields.has(field));
  if (unknownFields.length > 0) throw new ApiError(`Missing parent proposal contains unsupported fields: ${unknownFields.join(", ")}.`, 400);
  if (input.adminConfirmed !== true) throw new ApiError("Explicit Admin confirmation is required before category creation.", 403);
  const proposedName = parentText(input.proposedName, "category name", 120);
  const proposedSubcategoryName = optionalParentText(input.proposedSubcategoryName, "subcategory name");
  const proposedSubcategorySlug = proposedSubcategoryName
    ? parentSlugInput(input.proposedSubcategorySlug || proposedSubcategoryName, "subcategory slug")
    : "";
  if (!proposedSubcategoryName && input.proposedSubcategorySlug !== undefined && String(input.proposedSubcategorySlug || "").trim()) {
    throw new ApiError("A subcategory slug requires a subcategory name.", 400);
  }
  return {
    queueItemId: parentText(input.queueItemId, "queue item ID"),
    expectedPendingRevision: parentText(input.expectedPendingRevision, "pending revision", 160),
    expectedUpdatedAt: parentTimestamp(input.expectedUpdatedAt, "updatedAt"),
    expectedFingerprint: parentHashInput(input.expectedFingerprint, "fingerprint"),
    proposedName,
    proposedSlug: parentSlugInput(input.proposedSlug, "category slug"),
    proposedSubcategoryName,
    proposedSubcategorySlug,
    evidenceRefs: parentEvidenceRefs(input.evidenceRefs),
    adminConfirmed: true,
  };
};

export const launch1000MissingParentProposalId = (queueItemId: string, sourceFingerprint: string): string => (
  `parent-${parentHash({ queueItemId, sourceFingerprint }).slice(0, 48)}`
);

const parentTimestampString = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const candidate = value as { toDate?: () => Date; toMillis?: () => number };
    if (typeof candidate.toDate === "function") return candidate.toDate().toISOString();
    if (typeof candidate.toMillis === "function") return new Date(candidate.toMillis()).toISOString();
  }
  return "";
};

const parentRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const parentSourceEvidence = (queueItem: Record<string, unknown>): ParentSourceEvidence => {
  const supplierSnapshot = parentRecord(queueItem.supplierSnapshot);
  const supplierPayload = parentRecord(supplierSnapshot.productPayload);
  const titleCandidates: Array<[string, unknown]> = [
    ["supplierSnapshot.productPayload.name", supplierPayload.name],
    ["supplierSnapshot.productPayload.title", supplierPayload.title],
    ["supplierSnapshot.title", supplierSnapshot.title],
  ];
  const descriptionCandidates: Array<[string, unknown]> = [
    ["supplierSnapshot.productPayload.description", supplierPayload.description],
    ["supplierSnapshot.description", supplierSnapshot.description],
  ];
  const title = titleCandidates.find(([, value]) => typeof value === "string" && value.trim()) || ["", ""];
  const description = descriptionCandidates.find(([, value]) => typeof value === "string" && value.trim()) || ["", ""];
  const options: ParentSourceEvidenceOption[] = [];
  if (String(title[1] || "").trim()) options.push({ kind: "product_title", ref: title[0], value: String(title[1]).trim().slice(0, 2_000) });
  if (String(description[1] || "").trim()) options.push({ kind: "product_description", ref: description[0], value: String(description[1]).trim().slice(0, 4_000) });
  return { options, title: String(title[1] || "").trim(), description: String(description[1] || "").trim() };
};

const parentStopWords = new Set([
  "and", "the", "for", "with", "from", "new", "item", "product", "category", "general",
  "misc", "other", "goods", "supplies", "accessory", "accessories", "device", "devices",
]);

const parentTokens = (value: string): string[] => parentNormalized(value)
  .split(" ")
  .filter((token) => (token.length >= 3 || /\d/u.test(token)) && !parentStopWords.has(token));

const parentTokenMatches = (haystack: string, token: string): boolean => {
  const normalizedHaystack = parentNormalized(haystack).split(" ");
  const singular = token.endsWith("s") ? token.slice(0, -1) : token;
  return normalizedHaystack.some((candidate) => candidate === token || candidate === singular);
};

const parentMeaningTokens = (value: string): string[] => [...new Set(parentTokens(value).map((token) => (
  token.endsWith("s") ? token.slice(0, -1) : token
)))].sort();

const parentMeaningfullyEquivalent = (left: string, right: string): boolean => {
  const leftTokens = parentMeaningTokens(left);
  const rightTokens = parentMeaningTokens(right);
  return leftTokens.length > 0
    && leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
};

const parentIdentityNegationPrefixes: readonly string[][] = [
  ["not"],
  ["no"],
  ["without"],
  ["instead", "of"],
];

const parentIdentityNegationQualifiers = new Set([
  "a", "an", "the", "this", "that", "one", "actual", "real", "genuine", "specified", "listed", "intended",
]);

const parentDescriptionNegatesCandidate = (description: string, candidate: string): boolean => {
  const descriptionTokens = parentNormalized(description).split(" ").filter(Boolean);
  const candidateTokens = parentNormalized(candidate).split(" ").filter(Boolean);
  if (candidateTokens.length === 0) return false;
  return descriptionTokens.some((_, index) => parentIdentityNegationPrefixes.some((prefix) => {
    if (descriptionTokens.slice(index, index + prefix.length).join(" ") !== prefix.join(" ")) return false;
    let candidateStart = index + prefix.length;
    let qualifierCount = 0;
    while (qualifierCount < 3 && parentIdentityNegationQualifiers.has(descriptionTokens[candidateStart] || "")) {
      candidateStart += 1;
      qualifierCount += 1;
    }
    return descriptionTokens.slice(candidateStart, candidateStart + candidateTokens.length).join(" ") === candidateTokens.join(" ");
  }));
};

const parentEvidenceFingerprint = (options: ParentSourceEvidenceOption[]): string => parentHash(
  options.map(({ kind, ref, value }) => ({ kind, ref, value })),
);

const selectedParentEvidence = (
  evidence: ParentSourceEvidence,
  refs: readonly string[],
): ParentSourceEvidenceOption[] => {
  const selected = refs.map((ref) => evidence.options.find((option) => option.ref === ref)).filter(
    (option): option is ParentSourceEvidenceOption => Boolean(option),
  );
  if (selected.length !== refs.length || !selected.some((option) => option.kind === "product_title")) {
    throw new ApiError("Current supplier title evidence is missing or stale.", 409);
  }
  return selected;
};

const validateParentEvidence = (
  input: Launch1000ParentCategoryProposalInput,
  evidence: ParentSourceEvidence,
): ParentSourceEvidenceOption[] => {
  const selected = selectedParentEvidence(evidence, input.evidenceRefs);
  const selectedText = selected.map((option) => option.value).join(" ");
  const nameTerms = parentTokens(input.proposedName);
  const namePhraseInTitle = ` ${parentNormalized(evidence.title)} `.includes(` ${parentNormalized(input.proposedName)} `);
  const matchedNameTerms = nameTerms.filter((term) => parentTokenMatches(evidence.title, term));
  if (nameTerms.length === 0 || (!namePhraseInTitle && matchedNameTerms.length < Math.min(2, nameTerms.length))) {
    throw new ApiError("The proposed parent category is not supported by the current supplier title evidence.", 422);
  }
  if (parentDescriptionNegatesCandidate(evidence.description, input.proposedName)) {
    throw new ApiError("The supplier description contradicts the proposed parent category.", 422);
  }
  if (input.proposedSubcategoryName) {
    const subcategoryTerms = parentTokens(input.proposedSubcategoryName);
    const supported = subcategoryTerms.some((term) => parentTokenMatches(selectedText, term));
    if (subcategoryTerms.length === 0 || !supported) {
      throw new ApiError("The proposed subcategory is not supported by the current supplier evidence.", 422);
    }
  }
  return selected;
};

const assertPendingParentQueuePreconditions = (
  queueItem: Record<string, unknown>,
  input: Launch1000ParentCategoryProposalInput,
): { sourceFingerprint: string; evidence: ParentSourceEvidence; evidenceFingerprint: string; selectedEvidence: ParentSourceEvidenceOption[] } => {
  const queueState = String(queueItem.queueState || "").trim().toLowerCase();
  const status = String(queueItem.status || queueItem.reviewStatus || "").trim().toLowerCase();
  if (!(queueState === "review_pending" || (!queueState && status === "pending"))) {
    throw new ApiError("Only a pending supplier review item can create a parent category proposal.", 409);
  }
  const pendingRevision = String(queueItem.supplierOfferPendingRevision || "").trim();
  if (!pendingRevision || pendingRevision !== input.expectedPendingRevision) {
    throw new ApiError("This supplier review changed after it was opened. Reload before proposing a parent category.", 409);
  }
  const updatedAt = parentTimestampString(queueItem.updatedAt);
  if (!updatedAt || updatedAt !== input.expectedUpdatedAt) {
    throw new ApiError("This supplier review changed after it was opened. Reload before proposing a parent category.", 409);
  }
  const sourceFingerprint = launch1000RecordFingerprint(queueItem);
  if (sourceFingerprint !== input.expectedFingerprint) {
    throw new ApiError("This supplier review evidence changed after it was opened. Reload before proposing a parent category.", 409);
  }
  const evidence = parentSourceEvidence(queueItem);
  const selectedEvidence = validateParentEvidence(input, evidence);
  return {
    sourceFingerprint,
    evidence,
    selectedEvidence,
    evidenceFingerprint: parentEvidenceFingerprint(selectedEvidence),
  };
};

const parentGovernance = (value: unknown): ParentCategoryGovernanceRecord | null => {
  const record = parentRecord(value);
  const status = String(record.status || "");
  if (!["PENDING_ADMIN_APPROVAL", "APPROVED", "CREATED", "REJECTED"].includes(status)) return null;
  return {
    proposalId: String(record.proposalId || ""),
    proposalRevision: String(record.proposalRevision || ""),
    status: status as Launch1000TaxonomyGovernanceStatus,
    queueItemId: String(record.queueItemId || ""),
    expectedPendingRevision: String(record.expectedPendingRevision || ""),
    expectedUpdatedAt: String(record.expectedUpdatedAt || ""),
    expectedFingerprint: String(record.expectedFingerprint || ""),
    sourceFingerprint: String(record.sourceFingerprint || ""),
    evidenceFingerprint: String(record.evidenceFingerprint || ""),
    evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.map((entry) => String(entry)) : [],
    proposedName: String(record.proposedName || ""),
    proposedSlug: String(record.proposedSlug || ""),
    proposedSubcategoryName: String(record.proposedSubcategoryName || ""),
    proposedSubcategorySlug: String(record.proposedSubcategorySlug || ""),
    ...(record.approvedBy ? { approvedBy: String(record.approvedBy) } : {}),
    ...(record.approvedEmail ? { approvedEmail: String(record.approvedEmail) } : {}),
    ...(record.approvedAt ? { approvedAt: String(record.approvedAt) } : {}),
    ...(record.createdBy ? { createdBy: String(record.createdBy) } : {}),
    ...(record.createdEmail ? { createdEmail: String(record.createdEmail) } : {}),
    ...(record.createdAt ? { createdAt: String(record.createdAt) } : {}),
    ...(record.createdCategoryId ? { createdCategoryId: String(record.createdCategoryId) } : {}),
    ...(record.createdSubcategoryId ? { createdSubcategoryId: String(record.createdSubcategoryId) } : {}),
  };
};

const parentGovernanceRef = (db: Firestore, proposalId: string) => (
  db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(proposalId)
);

const parentAuditRef = (db: Firestore, operation: string, proposalId: string) => (
  db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).doc(`${operation}-${proposalId}`)
);

const parentCategorySnapshots = async (transaction: FirebaseFirestore.Transaction, db: Firestore) => {
  const snapshot = await transaction.get(db.collection("categories").limit(CATEGORY_SCAN_LIMIT));
  if (snapshot.size >= CATEGORY_SCAN_LIMIT) throw new ApiError("Category catalog is too large for a safe bounded reconciliation.", 503);
  return snapshot;
};

const equivalentParentCategory = (
  categories: FirebaseFirestore.QuerySnapshot,
  proposedName: string,
  proposedSlug: string,
): FirebaseFirestore.QueryDocumentSnapshot | null => {
  const normalizedName = parentNormalized(proposedName);
  return categories.docs.find((document) => {
    const data = document.data() || {};
    return parentNormalized(String(data.name || "")) === normalizedName
      || parentSlug(document.id) === proposedSlug
      || parentSlug(String(data.slug || "")) === proposedSlug
      || parentMeaningfullyEquivalent(String(data.name || ""), proposedName);
  }) || null;
};

const parentSourceIdentity = (queueItem: Record<string, unknown>) => {
  const supplierSnapshot = parentRecord(queueItem.supplierSnapshot);
  return {
    queueItemId: String(queueItem.id || "").trim() || null,
    sourceId: String(queueItem.sourceId || supplierSnapshot.sourceId || "").trim() || null,
    supplierProductId: String(queueItem.supplierProductId || supplierSnapshot.supplierProductId || supplierSnapshot.supplierItemCode || "").trim() || null,
    supplierOfferId: String(queueItem.supplierOfferId || supplierSnapshot.supplierOfferId || "").trim() || null,
    canonicalProductId: String(queueItem.matchedProductId || supplierSnapshot.canonicalProductId || parentRecord(queueItem.productPayload).id || "").trim() || null,
  };
};

const parentGovernanceDocument = (
  input: Launch1000ParentCategoryProposalInput,
  proposalId: string,
  sourceFingerprint: string,
  evidenceFingerprint: string,
  operator: Launch1000Operator,
  status: Launch1000TaxonomyGovernanceStatus,
  now: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "missing_parent_category",
  proposalId,
  proposalRevision: PARENT_CATEGORY_PROPOSAL_REVISION,
  status,
  queueItemId: input.queueItemId,
  expectedPendingRevision: input.expectedPendingRevision,
  expectedUpdatedAt: input.expectedUpdatedAt,
  expectedFingerprint: input.expectedFingerprint,
  sourceFingerprint,
  evidenceFingerprint,
  evidenceRefs: input.evidenceRefs,
  proposedName: input.proposedName,
  proposedSlug: input.proposedSlug,
  proposedSubcategoryName: input.proposedSubcategoryName,
  proposedSubcategorySlug: input.proposedSubcategorySlug,
  ...(status === "APPROVED" ? { approvedBy: operator.uid, approvedEmail: operator.email, approvedAt: now } : {}),
  ...(status === "CREATED" ? { createdBy: operator.uid, createdEmail: operator.email, createdAt: now } : {}),
  ...extra,
  updatedAt: now,
});

const assertSameParentProposal = (
  current: ParentCategoryGovernanceRecord,
  input: Launch1000ParentCategoryProposalInput,
  sourceFingerprint: string,
  evidenceFingerprint: string,
): void => {
  if (current.proposalRevision !== PARENT_CATEGORY_PROPOSAL_REVISION
    || current.queueItemId !== input.queueItemId
    || current.sourceFingerprint !== sourceFingerprint
    || current.evidenceFingerprint !== evidenceFingerprint
    || current.proposedName !== input.proposedName
    || current.proposedSlug !== input.proposedSlug
    || current.proposedSubcategoryName !== input.proposedSubcategoryName
    || current.proposedSubcategorySlug !== input.proposedSubcategorySlug) {
    throw new ApiError("A different parent category proposal already exists for this review evidence.", 409);
  }
};

export async function approveMissingParentCategoryProposal(
  db: Firestore,
  value: unknown,
  operator: Launch1000Operator,
): Promise<Launch1000ParentCategoryProposalResult> {
  const input = parseParentCategoryProposalInput(value);
  const queueReference = db.collection("supplier_review_queue").doc(input.queueItemId);
  const sourceFingerprintHint = input.expectedFingerprint;
  const proposalId = launch1000MissingParentProposalId(input.queueItemId, sourceFingerprintHint);
  const proposalGovernanceReference = parentGovernanceRef(db, proposalId);
  const now = new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const [queueSnapshot, governanceSnapshot] = await Promise.all([
      transaction.get(queueReference),
      transaction.get(proposalGovernanceReference),
    ]);
    if (!queueSnapshot.exists) throw new ApiError("Supplier review item could not be found.", 404);
    const queueItem = { ...(queueSnapshot.data() || {}), id: queueSnapshot.id };
    const validated = assertPendingParentQueuePreconditions(queueItem, input);
    const current = parentGovernance(governanceSnapshot.exists ? governanceSnapshot.data() : null);
    if (current) {
      assertSameParentProposal(current, input, validated.sourceFingerprint, validated.evidenceFingerprint);
      if (current.status === "CREATED") return { proposalId, proposalRevision: PARENT_CATEGORY_PROPOSAL_REVISION, status: "CREATED", idempotent: true, createdCategoryId: current.createdCategoryId, createdSubcategoryId: current.createdSubcategoryId };
      if (current.status === "APPROVED") return { proposalId, proposalRevision: PARENT_CATEGORY_PROPOSAL_REVISION, status: "APPROVED", idempotent: true };
      if (current.status === "REJECTED") throw new ApiError("The parent category proposal is rejected.", 409);
    }
    const categories = await parentCategorySnapshots(transaction, db);
    const equivalent = equivalentParentCategory(categories, input.proposedName, input.proposedSlug);
    if (equivalent) throw new ApiError(`An equivalent category already exists (${equivalent.id}); reconcile the existing taxonomy instead.`, 409);
    transaction.set(proposalGovernanceReference, parentGovernanceDocument(input, proposalId, validated.sourceFingerprint, validated.evidenceFingerprint, operator, "APPROVED", now), { merge: true });
    transaction.create(parentAuditRef(db, "parent-approve", proposalId), {
      id: `parent-approve-${proposalId}`,
      operation: "parent_approve",
      proposalId,
      proposalRevision: PARENT_CATEGORY_PROPOSAL_REVISION,
      queueItemId: input.queueItemId,
      operatorUid: operator.uid,
      operatorEmail: operator.email,
      sourceIdentity: parentSourceIdentity(queueItem),
      sourceFingerprint: validated.sourceFingerprint,
      evidenceFingerprint: validated.evidenceFingerprint,
      evidenceRefs: input.evidenceRefs,
      evidenceSnapshot: validated.selectedEvidence.map(({ kind, ref, value }) => ({ kind, ref, contentFingerprint: parentHash(value), length: value.length })),
      proposedName: input.proposedName,
      proposedSlug: input.proposedSlug,
      proposedSubcategoryName: input.proposedSubcategoryName || null,
      proposedSubcategorySlug: input.proposedSubcategorySlug || null,
      timestamp: now,
    });
    return { proposalId, proposalRevision: PARENT_CATEGORY_PROPOSAL_REVISION, status: "APPROVED" };
  });
}

const parseParentCreateInput = (value: unknown): { proposalId: string; proposalRevision: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Parent category creation request is invalid.", 400);
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((field) => !new Set(["proposalId", "proposalRevision"]).has(field));
  if (unknownFields.length > 0) throw new ApiError(`Parent category creation contains unsupported fields: ${unknownFields.join(", ")}.`, 400);
  const proposalId = parentText(input.proposalId, "proposal ID", 160);
  const proposalRevision = parentText(input.proposalRevision, "proposal revision", 80);
  if (proposalRevision !== PARENT_CATEGORY_PROPOSAL_REVISION) throw new ApiError("Parent category proposal revision is stale.", 409);
  return { proposalId, proposalRevision };
};

export async function createApprovedMissingParentCategory(
  db: Firestore,
  value: unknown,
  operator: Launch1000Operator,
): Promise<Launch1000ParentCategoryProposalResult> {
  const { proposalId, proposalRevision } = parseParentCreateInput(value);
  const proposalGovernanceReference = parentGovernanceRef(db, proposalId);
  let createdCategoryId = "";
  let createdSubcategoryId = "";
  let idempotent = false;
  await db.runTransaction(async (transaction) => {
    const governanceSnapshot = await transaction.get(proposalGovernanceReference);
    const current = parentGovernance(governanceSnapshot.exists ? governanceSnapshot.data() : null);
    if (!current || current.proposalRevision !== proposalRevision) throw new ApiError("Parent category proposal was not found or is stale.", 409);
    const queueReference = db.collection("supplier_review_queue").doc(current.queueItemId);
    const queueSnapshot = await transaction.get(queueReference);
    if (!queueSnapshot.exists) throw new ApiError("Supplier review item could not be found.", 404);
    const queueItem = { ...(queueSnapshot.data() || {}), id: queueSnapshot.id };
    const input: Launch1000ParentCategoryProposalInput = {
      queueItemId: current.queueItemId,
      expectedPendingRevision: current.expectedPendingRevision,
      expectedUpdatedAt: current.expectedUpdatedAt,
      expectedFingerprint: current.expectedFingerprint,
      proposedName: current.proposedName,
      proposedSlug: current.proposedSlug,
      proposedSubcategoryName: current.proposedSubcategoryName,
      proposedSubcategorySlug: current.proposedSubcategorySlug,
      evidenceRefs: current.evidenceRefs,
      adminConfirmed: true,
    };
    const validated = assertPendingParentQueuePreconditions(queueItem, input);
    if (validated.sourceFingerprint !== current.sourceFingerprint || validated.evidenceFingerprint !== current.evidenceFingerprint) {
      throw new ApiError("The approved parent category evidence is stale; review the product again.", 409);
    }
    if (current.status === "CREATED") {
      createdCategoryId = current.createdCategoryId || current.proposedSlug;
      createdSubcategoryId = current.createdSubcategoryId || "";
      idempotent = true;
      return;
    }
    if (current.status !== "APPROVED") throw new ApiError("Parent category proposal must be explicitly approved before creation.", 409);
    const categories = await parentCategorySnapshots(transaction, db);
    const equivalent = equivalentParentCategory(categories, current.proposedName, current.proposedSlug);
    if (equivalent) throw new ApiError(`An equivalent category already exists (${equivalent.id}); reconcile the existing taxonomy instead.`, 409);
    const categoryReference = db.collection("categories").doc(current.proposedSlug);
    const now = new Date().toISOString();
    createdCategoryId = current.proposedSlug;
    createdSubcategoryId = current.proposedSubcategorySlug;
    const subcategories = current.proposedSubcategoryName ? [{
      id: current.proposedSubcategorySlug,
      name: current.proposedSubcategoryName,
      slug: current.proposedSubcategorySlug,
      isActive: true,
      taxonomyCandidate: false,
      taxonomyStatus: "active",
      createdAt: now,
      createdBy: operator.uid,
    }] : [];
    transaction.create(categoryReference, {
      id: current.proposedSlug,
      name: current.proposedName,
      icon: "Layers",
      imageUrl: "",
      isActive: true,
      taxonomyCandidate: false,
      taxonomyStatus: "active",
      subcategories,
      specificationTemplate: [],
      createdAt: now,
      createdBy: operator.uid,
      parentCategoryProposalId: proposalId,
      parentCategoryProposalRevision: proposalRevision,
    });
    transaction.set(proposalGovernanceReference, {
      ...parentGovernanceDocument(input, proposalId, current.sourceFingerprint, current.evidenceFingerprint, operator, "CREATED", now),
      createdCategoryId,
      ...(createdSubcategoryId ? { createdSubcategoryId } : {}),
    }, { merge: true });
    transaction.create(parentAuditRef(db, "parent-create", proposalId), {
      id: `parent-create-${proposalId}`,
      operation: "parent_create",
      proposalId,
      proposalRevision,
      queueItemId: current.queueItemId,
      operatorUid: operator.uid,
      operatorEmail: operator.email,
      sourceIdentity: parentSourceIdentity(queueItem),
      sourceFingerprint: current.sourceFingerprint,
      evidenceFingerprint: current.evidenceFingerprint,
      evidenceRefs: current.evidenceRefs,
      proposedName: current.proposedName,
      proposedSlug: current.proposedSlug,
      proposedSubcategoryName: current.proposedSubcategoryName || null,
      proposedSubcategorySlug: current.proposedSubcategorySlug || null,
      createdCategoryId,
      createdSubcategoryId: createdSubcategoryId || null,
      timestamp: now,
    });
  });
  const categorySnapshot = await db.collection("categories").doc(createdCategoryId).get();
  const categoryData = categorySnapshot.data() || {};
  const createdGovernance = parentGovernance((await proposalGovernanceReference.get()).data());
  if (!categorySnapshot.exists
    || String(categoryData.id || "") !== createdCategoryId
    || String(categoryData.name || "") !== (createdGovernance?.proposedName || "")
    || categoryData.isActive !== true
    || categoryData.taxonomyCandidate === true) {
    throw new ApiError("Created parent category could not be verified after the transaction.", 500);
  }
  return { proposalId, proposalRevision, status: "CREATED", createdCategoryId, ...(createdSubcategoryId ? { createdSubcategoryId } : {}), ...(idempotent ? { idempotent: true } : {}) };
}
