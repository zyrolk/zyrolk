import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { isCanonicalActiveCategory } from "../suppliers/supplierProductMapping";
import {
  Launch1000ManifestSnapshot,
  Launch1000TaxonomyProposal,
  launch1000ParentRuleFingerprint,
  loadLaunch1000Snapshot,
} from "./launch1000Snapshot";

export const LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION = "launch1000_taxonomy_proposals";
export const LAUNCH1000_TAXONOMY_AUDIT_COLLECTION = "launch1000_taxonomy_audit";

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
