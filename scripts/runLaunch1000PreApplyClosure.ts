import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

type AnyRecord = Record<string, unknown>;

const ROOT = path.resolve(".local/launch-1000");
const CERTIFICATION = path.join(ROOT, "final-launch-pool-certification.json");
const SOURCE = path.join(ROOT, "final-pool-source-read.json");
const VIRTUAL = path.join(ROOT, "virtual-taxonomy-validation.json");
const SEMANTIC = path.join(ROOT, "image-semantic-pass-r8.json");
const SAMPLE_MANIFEST = path.join(ROOT, "image-sample-manifest-r8.json");
const GOVERNANCE = path.join(ROOT, "final-taxonomy-governance.json");
const APPLY_MANIFEST = path.join(ROOT, "final-production-apply-manifest.json");

function record(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function text(value: unknown): string { return String(value ?? "").trim(); }

function arr(value: unknown): AnyRecord[] { return Array.isArray(value) ? value.map(record) : []; }

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function categoryName(categories: readonly AnyRecord[], id: string): string {
  const item = categories.find((candidate) => text(candidate.id) === id);
  return text(record(item?.data).name) || id;
}

function subcategoryName(categories: readonly AnyRecord[], categoryId: string, subcategoryId: string): string {
  const category = categories.find((candidate) => text(candidate.id) === categoryId);
  const subcategories = arr(record(category?.data).subcategories);
  return text(subcategories.find((item) => text(item.id) === subcategoryId)?.name) || subcategoryId;
}

function sourcePool(source: string): string {
  if (source === "existing-safe") return "existing-safe";
  if (source === "family-proposal") return "family-proposal";
  if (source === "admin-clear") return "admin-clear";
  return "admin-recovery";
}

const certification = JSON.parse(await readFile(CERTIFICATION, "utf8")) as AnyRecord;
const source = JSON.parse(await readFile(SOURCE, "utf8")) as AnyRecord;
const virtual = JSON.parse(await readFile(VIRTUAL, "utf8")) as AnyRecord;
const semantic = JSON.parse(await readFile(SEMANTIC, "utf8")) as AnyRecord;
const sampleManifest = JSON.parse(await readFile(SAMPLE_MANIFEST, "utf8")) as AnyRecord;

const categories = arr(source.categories);
const manifest = arr(certification.manifest);
const virtualNodes = arr(record(virtual.virtualTaxonomy).nodes);
const familyCounts = arr(virtual.familyCounts);
const semanticById = new Map(arr(semantic.results).map((item) => [text(item.candidateId), item]));
const sampleById = new Map(arr(sampleManifest.manifest).map((item) => [text(item.candidateId), item]));
const virtualById = new Map(virtualNodes.map((item) => [text(item.id), item]));
const familyCountById = new Map(familyCounts.map((item) => [text(item.familyId), item]));

const ids = manifest.map((item) => text(item.id));
const skus = manifest.map((item) => text(item.sku));
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
const duplicateSkus = skus.filter((sku, index) => skus.indexOf(sku) !== index);

const liveSubcategoryKeys = new Set<string>();
const liveSubcategorySlugs = new Set<string>();
for (const category of categories) {
  for (const subcategory of arr(record(category.data).subcategories)) {
    const name = text(subcategory.name);
    const id = text(subcategory.id);
    if (id && name) {
      liveSubcategoryKeys.add(`${text(category.id)}:${id}`);
      liveSubcategorySlugs.add(slug(name));
    }
  }
}

const governance = virtualNodes.map((node) => {
  const nodeId = text(node.id);
  const parentId = text(node.parentId);
  const label = text(node.name);
  const familyId = text(node.familyId);
  const selected = manifest.filter((item) => text(item.subcategoryId) === nodeId || text(item.clusterId) === familyId);
  const family = familyCountById.get(familyId) || {};
  const parent = categories.find((item) => text(item.id) === parentId);
  const requiredFields = arr(record(parent?.data).specificationTemplate).filter((field) => field.required === true).map((field) => text(field.name)).filter(Boolean);
  const nameCollision = [...liveSubcategorySlugs].includes(slug(label));
  const idCollision = liveSubcategoryKeys.has(`${parentId}:${nodeId}`);
  const recommendation = nameCollision || idCollision ? "MERGE_WITH_EXISTING" : selected.length < 3 ? "REJECT" : "APPROVE";
  return {
    proposalId: nodeId,
    proposedLabel: label,
    proposedSlug: slug(label),
    parentCategory: { id: parentId, name: categoryName(categories, parentId) },
    description: `Product-family taxonomy proposal for ${familyId}; local-only until Admin governance approval.`,
    includedClusterIds: unique([familyId, ...selected.map((item) => text(item.clusterId))]),
    candidateCount: selected.length || Number(family.candidateCount || 0),
    examples: selected.slice(0, 5).map((item) => ({ id: text(item.id), sku: text(item.sku), title: text(item.title) })),
    inheritedRequiredFields: requiredFields,
    equivalentExistingTaxonomy: nameCollision || idCollision,
    nameCollision,
    slugCollision: nameCollision,
    tooBroad: false,
    tooNarrow: selected.length < 3,
    supplierSpecific: false,
    recommendation,
    status: "LOCAL_RECOMMENDATION_ONLY",
  };
});

const recovery = manifest
  .filter((item) => text(item.source).startsWith("admin-recovery:"))
  .map((item) => {
    const sourceReason = text(item.source).slice("admin-recovery:".length);
    const semanticResult = semanticById.get(text(item.id)) || {};
    const blockers = arr(item.blockers).map((value) => text(value)).filter(Boolean);
    const decision = blockers.length > 0 ? "REMOVE_FROM_LAUNCH" : "ADMIN_CHOICE_REQUIRED";
    return {
      id: text(item.id),
      sku: text(item.sku),
      title: text(item.title),
      localAssignmentReason: sourceReason,
      categoryId: text(item.categoryId),
      category: categoryName(categories, text(item.categoryId)),
      subcategoryId: text(item.subcategoryId),
      subcategory: subcategoryName(categories, text(item.categoryId), text(item.subcategoryId)),
      evidence: [...arr(semanticResult.evidence).map((value) => text(value)).filter(Boolean), text(item.title)].filter(Boolean),
      blockers,
      managedMediaVerified: record(item.imageVerification).supported === true,
      decision,
      status: "LOCAL_RECOMMENDATION_ONLY",
    };
  });

const applyManifest = manifest.map((item, index) => {
  const categoryId = text(item.categoryId);
  const subcategoryId = text(item.subcategoryId);
  const virtualProposal = virtualById.get(subcategoryId);
  const visualSample = sampleById.get(text(item.id));
  const visualReviewState = text(item.id) === "dropex-atfch-313"
    ? "VISUAL_MISMATCH"
    : visualSample
      ? "FETCHED_NOT_VISUALLY_REVIEWED"
      : "VISUAL_REVIEW_PENDING";
  return {
    productId: text(item.id),
    sku: text(item.sku),
    title: text(item.title),
    sourcePool: sourcePool(text(item.source)),
    sourceCluster: text(item.clusterId),
    taxonomyDecisionSource: text(item.source),
    parentCategory: { id: categoryId, name: categoryName(categories, categoryId) },
    proposedSubcategory: {
      id: subcategoryId,
      label: virtualProposal ? text(virtualProposal.name) : subcategoryName(categories, categoryId, subcategoryId),
      virtualProposalId: virtualProposal ? subcategoryId : null,
      revision: virtualProposal ? "launch1000-taxonomy-r1" : null,
    },
    deterministicSpecNormalization: record(item.specNormalization),
    mediaCertification: {
      publicationReadyPredicate: record(item.media).publicationReadyPredicate === true,
      primaryPresent: record(item.media).primaryPresent === true,
      storageMetadataReadable: record(item.imageVerification).readable === true,
      supportedMimeAndSize: record(item.imageVerification).supported === true,
    },
    visualReviewState,
    validatorResult: { class: text(item.class), blockers: arr(item.blockers).map((value) => text(value)).filter(Boolean) },
    auditEvidence: {
      title: text(item.title),
      cluster: text(item.clusterId),
      source: text(item.source),
      mediaStatus: text(record(item.media).imageStatus),
      semanticEvidence: arr(semanticById.get(text(item.id))?.evidence).map((value) => text(value)).filter(Boolean),
    },
    launchPriorityRank: index + 1,
  };
});

const visualClusters = new Map<string, AnyRecord[]>();
for (const item of applyManifest) {
  const key = text(item.sourceCluster);
  const list = visualClusters.get(key) || [];
  list.push(item);
  visualClusters.set(key, list);
}
const visualPlan = [...visualClusters.entries()].map(([clusterId, items]) => {
  const sampleSize = items.length >= 10 ? Math.min(4, items.length) : 1;
  return {
    clusterId,
    selectedCount: items.length,
    requiredReviewImages: sampleSize,
    representativeIds: items.slice(0, sampleSize).map((item) => item.productId),
    status: items.some((item) => item.visualReviewState === "VISUAL_REVIEW_PENDING" || item.visualReviewState === "FETCHED_NOT_VISUALLY_REVIEWED") ? "PENDING" : "COMPLETE",
  };
});

const output = {
  generatedAt: new Date().toISOString(),
  projectId: "zyrolk-e0164",
  readOnly: true,
  baseline: "b1339936f1f8fd2b9d6d54303b40f112d7e0d340",
  capacity: { currentActive: 241, selectedNetNew: manifest.length, potentialActive: 241 + manifest.length, target800: manifest.length >= 800, target820: manifest.length >= 820 },
  reconciliation: { total: manifest.length, uniqueIds: duplicateIds.length === 0, uniqueSkus: duplicateSkus.length === 0, duplicateIds: unique(duplicateIds), duplicateSkus: unique(duplicateSkus) },
  taxonomyGovernance: { proposalCount: governance.length, proposals: governance, sportsIncluded: false },
  recoveryDecisionFreeze: { selectedCount: recovery.length, decisions: recovery, status: recovery.every((item) => item.decision === "APPROVE_FOR_LAUNCH") ? "LOCAL_RECOMMENDATIONS_ONLY" : "REVIEW_REQUIRED" },
  visualReview: {
    clusterCount: visualPlan.length,
    plan: visualPlan,
    fetchedPriorSampleCount: sampleById.size,
    reviewedCount: 1,
    reviewedIds: ["dropex-atfch-313"],
    mismatchIds: ["dropex-atfch-313"],
    mismatchNotes: [{ id: "dropex-atfch-313", note: "Managed image visibly depicts an umbrella while the product title is Heat Resistant Food cover." }],
    status: "PENDING_MANUAL_REVIEW",
  },
  manifest: applyManifest,
};

await mkdir(ROOT, { recursive: true });
await writeFile(GOVERNANCE, `${JSON.stringify({ generatedAt: output.generatedAt, readOnly: true, ...output.taxonomyGovernance }, null, 2)}\n`, "utf8");
await writeFile(APPLY_MANIFEST, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ governance: GOVERNANCE, applyManifest: APPLY_MANIFEST, selected: manifest.length, taxonomyProposals: governance.length, recovery: recovery.length, visualClusters: visualPlan.length, visualReviewStatus: output.visualReview.status }, null, 2));
