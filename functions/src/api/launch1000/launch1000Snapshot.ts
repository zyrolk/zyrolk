import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { ApiError } from "../errors";

export const LAUNCH1000_MANIFEST_FILE = "final800-manifest.json";
export const LAUNCH1000_TAXONOMY_FILE = "taxonomy-proposals.json";

export type Launch1000SourcePool = "existing-safe" | "family-proposal" | "admin-clear" | "admin-recovery";

export interface Launch1000ManifestEntry {
  productId: string;
  sku: string;
  sourcePool: Launch1000SourcePool;
  sourceCluster: string;
  taxonomyDecisionSource: string;
  parentCategoryId: string;
  parentCategoryLabel: string;
  subcategoryId: string;
  subcategoryLabel: string;
  taxonomyProposalId: string | null;
  deterministicSpecNormalization: Record<string, string>;
  launchPriority: number;
  validatorCertificationState: string;
  visualCertificationState: string;
}

export interface Launch1000TaxonomyProposal {
  proposalId: string;
  revision: string;
  parentCategoryId: string;
  parentCategoryLabel: string;
  proposedLabel: string;
  proposedSlug: string;
  affectedFinalManifestCount: number;
  inheritedParentRuleBehavior: string;
  collisionStatus: string;
  governanceStatus: "PENDING_ADMIN_APPROVAL";
}

export interface Launch1000ManifestSnapshot {
  manifestRevision: string;
  entries: Launch1000ManifestEntry[];
  taxonomyProposals: Launch1000TaxonomyProposal[];
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const text = (value: unknown, field: string, max = 240): string => {
  if (typeof value !== "string") throw new ApiError(`Launch-1000 ${field} is invalid.`, 500);
  const result = value.trim();
  if (!result || result.length > max || result.includes("/")) throw new ApiError(`Launch-1000 ${field} is invalid.`, 500);
  return result;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const launch1000ParentRuleFingerprint = (category: Record<string, unknown>): string => createHash("sha256")
  .update(stableJson({
    isActive: category.isActive === true,
    taxonomyCandidate: category.taxonomyCandidate === true,
    specificationTemplate: Array.isArray(category.specificationTemplate) ? category.specificationTemplate : [],
    activeSubcategoryRequired: Array.isArray(category.subcategories)
      && category.subcategories.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).isActive !== false),
  }), "utf8")
  .digest("hex");

export const launch1000RecordFingerprint = (record: Record<string, unknown>): string => createHash("sha256")
  .update(stableJson({
    updatedAt: record.updatedAt ?? null,
    supplierOfferPendingRevision: record.supplierOfferPendingRevision ?? null,
    queueState: record.queueState ?? null,
    status: record.status ?? null,
    sourceId: record.sourceId ?? null,
    productPayload: record.productPayload ?? null,
    productValidation: record.productValidation ?? null,
    managedMedia: record.managedMedia ?? null,
    mediaStatus: record.mediaStatus ?? null,
    mediaQueueClass: record.mediaQueueClass ?? null,
    mediaFailures: record.mediaFailures ?? null,
    supplierSnapshot: record.supplierSnapshot ?? null,
  }), "utf8")
  .digest("hex");

const snapshotDirectories = (): string[] => {
  const configured = typeof process.env.LAUNCH1000_SNAPSHOT_DIR === "string"
    ? process.env.LAUNCH1000_SNAPSHOT_DIR.trim()
    : "";
  return [...new Set([
    ...(configured ? [path.resolve(configured)] : []),
    path.resolve(process.cwd(), "config/launch1000"),
    path.resolve(__dirname, "../../config/launch1000"),
    path.resolve(__dirname, "../../../../config/launch1000"),
  ])];
};

const snapshotDirectory = (): string => {
  const directory = snapshotDirectories().find((candidate) => (
    existsSync(path.join(candidate, LAUNCH1000_MANIFEST_FILE))
      && existsSync(path.join(candidate, LAUNCH1000_TAXONOMY_FILE))
  ));
  if (!directory) {
    throw new ApiError("Launch-1000 server snapshot is unavailable; apply is fail-closed.", 503);
  }
  return directory;
};

const parseJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new ApiError("Launch-1000 server snapshot is invalid.", 500);
  }
};

const parseManifest = (value: unknown): { revision: string; entries: Launch1000ManifestEntry[] } => {
  const record = asRecord(value);
  const revision = text(record.manifestRevision, "manifest revision", 160);
  const entriesValue = record.entries;
  if (!Array.isArray(entriesValue) || entriesValue.length === 0 || entriesValue.length > 800) {
    throw new ApiError("Launch-1000 manifest entries are invalid.", 500);
  }
  const ids = new Set<string>();
  const skus = new Set<string>();
  const entries = entriesValue.map((entryValue) => {
    const entry = asRecord(entryValue);
    const productId = text(entry.productId, "product ID", 160);
    const sku = text(entry.sku, "SKU", 160);
    if (ids.has(productId) || skus.has(sku)) throw new ApiError("Launch-1000 manifest identity is duplicated.", 500);
    ids.add(productId);
    skus.add(sku);
    const sourcePool = entry.sourcePool;
    if (!["existing-safe", "family-proposal", "admin-clear", "admin-recovery"].includes(String(sourcePool))) {
      throw new ApiError("Launch-1000 manifest source pool is invalid.", 500);
    }
    const normalization = asRecord(entry.deterministicSpecNormalization);
    const deterministicSpecNormalization = Object.fromEntries(Object.entries(normalization)
      .filter(([key]) => key !== "evidence")
      .map(([key, item]) => [
        text(key, "specification name", 100),
        text(item, "specification value", 500),
      ]));
    const taxonomyProposalId = entry.taxonomyProposalId === null || entry.taxonomyProposalId === undefined
      ? null
      : text(entry.taxonomyProposalId, "taxonomy proposal ID", 160);
    if (String(entry.subcategoryId || "").startsWith("virtual-")) {
      throw new ApiError("Launch-1000 manifest contains a fake production taxonomy ID.", 500);
    }
    if (entry.validatorCertificationState !== "CERTIFIED_CLEAN" || entry.visualCertificationState !== "VISUAL_MATCH") {
      throw new ApiError("Launch-1000 manifest contains an uncertified product.", 500);
    }
    return {
      productId,
      sku,
      sourcePool: sourcePool as Launch1000SourcePool,
      sourceCluster: text(entry.sourceCluster, "source cluster", 300),
      taxonomyDecisionSource: text(entry.taxonomyDecisionSource, "taxonomy decision source", 160),
      parentCategoryId: text(entry.parentCategoryId, "parent category ID", 160),
      parentCategoryLabel: text(entry.parentCategoryLabel, "parent category label", 200),
      subcategoryId: entry.subcategoryId === null || entry.subcategoryId === undefined
        ? ""
        : text(entry.subcategoryId, "subcategory ID", 160),
      subcategoryLabel: entry.subcategoryLabel === null || entry.subcategoryLabel === undefined
        ? ""
        : text(entry.subcategoryLabel, "subcategory label", 200),
      taxonomyProposalId,
      deterministicSpecNormalization,
      launchPriority: Number.isInteger(entry.launchPriority) ? Number(entry.launchPriority) : 999_999,
      validatorCertificationState: "CERTIFIED_CLEAN",
      visualCertificationState: "VISUAL_MATCH",
    };
  }).sort((left, right) => left.launchPriority - right.launchPriority || left.productId.localeCompare(right.productId));
  return { revision, entries };
};

const parseProposals = (value: unknown): Launch1000TaxonomyProposal[] => {
  const record = asRecord(value);
  const revision = text(record.revision, "taxonomy governance revision", 160);
  if (record.governanceStatus !== "PENDING_ADMIN_APPROVAL" || !Array.isArray(record.proposals)) {
    throw new ApiError("Launch-1000 taxonomy governance snapshot is invalid.", 500);
  }
  const ids = new Set<string>();
  return record.proposals.map((proposalValue) => {
    const proposal = asRecord(proposalValue);
    const proposalId = text(proposal.proposalId, "proposal ID", 160);
    if (ids.has(proposalId)) throw new ApiError("Launch-1000 taxonomy proposal IDs are duplicated.", 500);
    ids.add(proposalId);
    if (proposal.revision !== revision || proposal.governanceStatus !== "PENDING_ADMIN_APPROVAL") {
      throw new ApiError("Launch-1000 taxonomy proposal revision/status is invalid.", 500);
    }
    return {
      proposalId,
      revision,
      parentCategoryId: text(proposal.parentCategoryId, "proposal parent category ID", 160),
      parentCategoryLabel: text(proposal.parentCategoryLabel, "proposal parent category label", 200),
      proposedLabel: text(proposal.proposedLabel, "proposal label", 200),
      proposedSlug: text(proposal.proposedSlug, "proposal slug", 160),
      affectedFinalManifestCount: Number.isInteger(proposal.affectedFinalManifestCount) ? Number(proposal.affectedFinalManifestCount) : 0,
      inheritedParentRuleBehavior: text(proposal.inheritedParentRuleBehavior, "proposal parent rule behavior", 240),
      collisionStatus: text(proposal.collisionStatus, "proposal collision status", 120),
      governanceStatus: "PENDING_ADMIN_APPROVAL",
    };
  });
};

export const loadLaunch1000Snapshot = (): Launch1000ManifestSnapshot => {
  const directory = snapshotDirectory();
  const { revision, entries } = parseManifest(parseJsonFile(path.join(directory, LAUNCH1000_MANIFEST_FILE)));
  return {
    manifestRevision: revision,
    entries,
    taxonomyProposals: parseProposals(parseJsonFile(path.join(directory, LAUNCH1000_TAXONOMY_FILE))),
  };
};

export const loadLaunch1000SnapshotFromValues = (manifest: unknown, proposals: unknown): Launch1000ManifestSnapshot => {
  const { revision, entries } = parseManifest(manifest);
  return { manifestRevision: revision, entries, taxonomyProposals: parseProposals(proposals) };
};
