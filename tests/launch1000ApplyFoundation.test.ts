import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  applyLaunch1000ProductPilot,
  dryRunLaunch1000ProductApply,
  parseLaunch1000ApplyRequest,
  parseLaunch1000DryRunRequest,
  LAUNCH1000_APPLY_AUDIT_COLLECTION,
  LAUNCH1000_APPLY_OPERATIONS_COLLECTION,
  LAUNCH1000_PILOT_BATCH_MAX,
} from "../functions/src/api/launch1000/launch1000Apply";
import {
  approveLaunch1000TaxonomyProposal,
  createApprovedLaunch1000TaxonomyProposal,
  previewLaunch1000TaxonomyProposals,
  LAUNCH1000_TAXONOMY_AUDIT_COLLECTION,
  LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION,
} from "../functions/src/api/launch1000/launch1000Governance";
import {
  launch1000RecordFingerprint,
  loadLaunch1000Snapshot,
  loadLaunch1000SnapshotFromValues,
} from "../functions/src/api/launch1000/launch1000Snapshot";

const canRunFirestore = /^(127\.0\.0\.1|localhost):\d+$/u.test(String(process.env.FIRESTORE_EMULATOR_HOST || "").trim())
  && String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "demo-zyro-launch1000").startsWith("demo-");

const operator = { uid: "launch1000-test-admin", email: "launch1000-test@example.invalid" };

const snapshotFor = (
  productId: string,
  proposalId: string | null = null,
  parentCategoryId = "test-category",
  proposalLabel = "Test Subcategory",
  proposalSlug = "test-subcategory",
) => loadLaunch1000SnapshotFromValues({
  manifestRevision: "manifest-test-r1",
  entries: [{
    productId,
    sku: `${productId}-sku`,
    sourcePool: proposalId ? "family-proposal" : "existing-safe",
    sourceCluster: "test-cluster",
    taxonomyDecisionSource: proposalId ? "test-proposal" : "trusted-existing-taxonomy",
    parentCategoryId,
    parentCategoryLabel: "Test Category",
    subcategoryId: proposalId ? null : proposalSlug,
    subcategoryLabel: proposalId ? null : proposalLabel,
    taxonomyProposalId: proposalId,
    deterministicSpecNormalization: {},
    launchPriority: 1,
    validatorCertificationState: "CERTIFIED_CLEAN",
    visualCertificationState: "VISUAL_MATCH",
  }],
}, {
  revision: "taxonomy-test-r1",
  governanceStatus: "PENDING_ADMIN_APPROVAL",
  proposals: proposalId ? [{
    proposalId,
    revision: "taxonomy-test-r1",
    parentCategoryId,
    parentCategoryLabel: "Test Category",
    proposedLabel: proposalLabel,
    proposedSlug: proposalSlug,
    affectedFinalManifestCount: 1,
    inheritedParentRuleBehavior: "INHERIT_ACTIVE_PARENT_REQUIRED_SUBCATEGORY_AND_SPEC_RULES",
    collisionStatus: "NO_EQUIVALENT_REPORTED",
    governanceStatus: "PENDING_ADMIN_APPROVAL",
  }] : [],
});

const queueRecordFor = (productId: string, updatedAt: string) => ({
  status: "Pending",
  queueState: "review_pending",
  reviewStatus: "Pending",
  sourceId: "dropex",
  supplierOfferPendingRevision: "supplier-revision-1",
  updatedAt,
  comparisonStatus: "NEW_PRODUCT",
  comparison: { comparisonStatus: "NEW_PRODUCT", changedFields: [], matchedProductLive: false },
  productPayload: {
    id: productId,
    name: "Test managed product",
    description: "A complete test product with a managed image.",
    price: 20,
    costPrice: 10,
    stock: 8,
    category: "",
    subcategory: "",
    imageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media",
    imageUrls: ["https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media"],
    isActive: false,
    active: false,
    visible: false,
    specs: {},
    supplierMetadata: { supplierStockAvailable: true, supplierCostAvailable: true },
  },
  supplierSnapshot: {
    sourceId: "dropex",
    supplierId: "dropex",
    inventoryLevel: 8,
    providedFields: ["stock", "inventoryLevel"],
    supplierMetadata: { supplierStockAvailable: true, supplierCostAvailable: true },
    imageUrls: ["https://supplier.example/managed.webp"],
  },
  mediaSourceImageUrls: ["https://supplier.example/managed.webp"],
  managedMedia: [{
    contentHash: "a".repeat(64),
    firebaseStorageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media",
    originalSupplierUrl: "https://supplier.example/managed.webp",
    imageStatus: "ready",
    isPrimary: true,
    sortOrder: 0,
    storagePath: "supplier-review/test/managed.webp",
  }],
  mediaStatus: "ready",
  mediaQueueClass: "ready",
  mediaFailures: [],
  supplierSyncState: { batchId: "sync-before", state: "pending", revision: "sync-1" },
  productValidation: { readyToPublish: false, missingFields: ["category"], errors: [{ field: "category", code: "required" }] },
});

const withEmulator = async (callback: (db: Firestore) => Promise<void>): Promise<void> => {
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "demo-zyro-launch1000" }, `launch1000-${randomUUID()}`);
  try {
    await callback(getFirestore(app));
  } finally {
    await deleteApp(app);
  }
};

test("Launch-1000 snapshot is immutable, bounded, and proposal references are separate from manifest revision", () => {
  const snapshot = loadLaunch1000Snapshot();
  assert.equal(snapshot.entries.length, 800);
  assert.equal(snapshot.taxonomyProposals.length, 26);
  assert.equal(snapshot.entries.filter((entry) => entry.taxonomyProposalId).length, 451);
  assert.equal(snapshot.taxonomyProposals[0]?.revision, "launch1000-taxonomy-r1");
  assert.equal(snapshot.manifestRevision, "launch1000-final800-visual-freeze-r1");
  assert.notEqual(snapshot.manifestRevision, snapshot.taxonomyProposals[0]?.revision);
});

test("Launch-1000 request parsers enforce the pilot ceiling and dry-run preconditions", () => {
  assert.equal(LAUNCH1000_PILOT_BATCH_MAX, 20);
  assert.deepEqual(parseLaunch1000DryRunRequest({ manifestRevision: "manifest-r1", productIds: ["p1"] }), {
    manifestRevision: "manifest-r1",
    productIds: ["p1"],
  });
  assert.throws(
    () => parseLaunch1000DryRunRequest({ manifestRevision: "manifest-r1", productIds: Array.from({ length: 21 }, (_, index) => `p${index}`) }),
    /limited to 20/u,
  );
  assert.throws(
    () => parseLaunch1000ApplyRequest({ manifestRevision: "manifest-r1", productIds: ["p1"], operationId: "op-1", preconditions: {} }),
    /precondition/u,
  );
});

test("taxonomy governance preview, approval, creation, and repeat creation are idempotent", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const proposalId = `proposal-${randomUUID()}`;
    const snapshot = snapshotFor(`product-${randomUUID()}`, proposalId);
    await db.collection("categories").doc("test-category").set({
      name: "Test Category",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [],
    });

    const preview = await previewLaunch1000TaxonomyProposals(db, { proposalIds: [proposalId], revision: "taxonomy-test-r1" }, snapshot);
    assert.equal(preview.proposals[0]?.status, "PENDING_ADMIN_APPROVAL");
    assert.equal(preview.proposals[0]?.collision, false);

    const approved = await approveLaunch1000TaxonomyProposal(db, { proposalId, revision: "taxonomy-test-r1" }, operator, snapshot);
    assert.equal(approved.status, "APPROVED");
    const approvedAgain = await approveLaunch1000TaxonomyProposal(db, { proposalId, revision: "taxonomy-test-r1" }, operator, snapshot);
    assert.equal(approvedAgain.idempotent, true);

    const created = await createApprovedLaunch1000TaxonomyProposal(db, { proposalId, revision: "taxonomy-test-r1" }, operator, snapshot);
    assert.equal(created.status, "CREATED");
    const createdAgain = await createApprovedLaunch1000TaxonomyProposal(db, { proposalId, revision: "taxonomy-test-r1" }, operator, snapshot);
    assert.equal(createdAgain.idempotent, true);
    assert.equal(createdAgain.createdSubcategoryId, created.createdSubcategoryId);

    const parent = (await db.collection("categories").doc("test-category").get()).data() || {};
    const subcategories = Array.isArray(parent.subcategories) ? parent.subcategories : [];
    assert.equal(subcategories.filter((item) => item && (item as Record<string, unknown>).id === created.createdSubcategoryId).length, 1);
    assert.equal((await db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(proposalId).get()).data()?.status, "CREATED");
    assert.equal((await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).get()).size, 2);
  });
});

test("taxonomy governance rejects equivalent and deterministic-ID collisions", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const equivalentProposalId = `proposal-${randomUUID()}`;
    const equivalentSnapshot = snapshotFor(`product-${randomUUID()}`, equivalentProposalId);
    await db.collection("categories").doc("test-category").set({
      name: "Test Category",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "existing-subcategory", name: "Test Subcategory", slug: "test-subcategory", isActive: true, taxonomyCandidate: false }],
    });
    await assert.rejects(
      approveLaunch1000TaxonomyProposal(db, { proposalId: equivalentProposalId, revision: "taxonomy-test-r1" }, operator, equivalentSnapshot),
      /equivalent active subcategory/u,
    );

    const collisionCategoryId = `category-${randomUUID()}`;
    const collisionProposalId = `proposal-${randomUUID()}`;
    const collisionSnapshot = snapshotFor(`product-${randomUUID()}`, collisionProposalId, collisionCategoryId, "Collision Subcategory", "collision-subcategory");
    await db.collection("categories").doc(collisionCategoryId).set({
      name: "Test Category",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "launch1000-collision-subcategory", name: "Unrelated Existing Node", slug: "unrelated-existing-node", isActive: true, taxonomyCandidate: false }],
    });
    await approveLaunch1000TaxonomyProposal(db, { proposalId: collisionProposalId, revision: "taxonomy-test-r1" }, operator, collisionSnapshot);
    await assert.rejects(
      createApprovedLaunch1000TaxonomyProposal(db, { proposalId: collisionProposalId, revision: "taxonomy-test-r1" }, operator, collisionSnapshot),
      /deterministic Launch-1000 taxonomy ID is already occupied/u,
    );
  });
});

test("product dry-run is zero-write and eligible apply updates only review projection state", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `product-${randomUUID()}`;
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    const updatedAt = "2026-10-10T00:00:00.000Z";
    const queueRecord = queueRecordFor(productId, updatedAt);
    await db.collection("categories").doc("test-category").set({
      name: "Test Category",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", slug: "test-subcategory", isActive: true, taxonomyCandidate: false }],
    });
    await queueReference.set(queueRecord);
    const productReference = db.collection("products").doc(productId);
    const productBefore = {
      id: productId,
      isActive: false,
      visible: false,
      stock: 8,
      supplierObservedStock: 8,
      localDemand: 2,
      category: "",
    };
    await productReference.set(productBefore);
    const snapshot = snapshotFor(productId);
    const categoryReference = db.collection("categories").doc("test-category");
    const governanceReference = db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc("unused-proposal");
    const productPrivateReference = db.collection("product_private").doc(productId);
    const queueBefore = (await queueReference.get()).data();
    const categoryBefore = (await categoryReference.get()).data();
    const governanceBefore = (await governanceReference.get()).data();
    const productPrivateBefore = (await productPrivateReference.get()).data();
    const operationsBefore = (await db.collection(LAUNCH1000_APPLY_OPERATIONS_COLLECTION).get()).size;
    const auditsBefore = (await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get()).size;

    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision: "manifest-test-r1", productIds: [productId] }, snapshot);
    assert.equal(dryRun.results[0]?.outcome, "ELIGIBLE");
    assert.deepEqual((await queueReference.get()).data(), queueBefore);
    assert.deepEqual((await categoryReference.get()).data(), categoryBefore);
    assert.deepEqual((await governanceReference.get()).data(), governanceBefore);
    assert.deepEqual((await productReference.get()).data(), productBefore);
    assert.deepEqual((await productPrivateReference.get()).data(), productPrivateBefore);
    assert.equal((await db.collection(LAUNCH1000_APPLY_OPERATIONS_COLLECTION).get()).size, operationsBefore);
    assert.equal((await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get()).size, auditsBefore);
    assert.equal((await queueReference.get()).data()?.launch1000Apply, undefined);
    assert.equal((await db.collection(LAUNCH1000_APPLY_OPERATIONS_COLLECTION).get()).size, 0);
    assert.equal((await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get()).size, 0);

    const precondition = dryRun.results[0];
    const applied = await applyLaunch1000ProductPilot(db, {
      manifestRevision: "manifest-test-r1",
      productIds: [productId],
      operationId: `operation-${randomUUID()}`,
      preconditions: {
        [productId]: {
          expectedUpdatedAt: precondition?.expectedUpdatedAt || "",
          expectedFingerprint: precondition?.expectedFingerprint || "",
        },
      },
    }, operator, snapshot);
    assert.equal(applied.results[0]?.outcome, "APPLIED");
    const after = (await queueReference.get()).data() || {};
    const afterPayload = (after.productPayload || {}) as Record<string, unknown>;
    assert.equal(afterPayload.category, "test-category");
    assert.equal(afterPayload.subcategory, "test-subcategory");
    assert.equal(after.businessQueueClassesVersion, 2);
    assert.equal((after.productValidation || {}).readyToPublish, true);
    assert.equal((after.launch1000Apply || {}).outcome, "READY_FOR_REVIEW");
    assert.equal(afterPayload.stock, queueRecord.productPayload.stock);
    assert.deepEqual(after.managedMedia, queueRecord.managedMedia);
    assert.deepEqual(after.supplierSyncState, queueRecord.supplierSyncState);
    assert.deepEqual((await productReference.get()).data(), productBefore);
    assert.equal((await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get()).size, 1);

    const repeated = await applyLaunch1000ProductPilot(db, {
      manifestRevision: "manifest-test-r1",
      productIds: [productId],
      operationId: applied.operationId,
      preconditions: {
        [productId]: {
          expectedUpdatedAt: precondition?.expectedUpdatedAt || "",
          expectedFingerprint: precondition?.expectedFingerprint || "",
        },
      },
    }, operator, snapshot);
    assert.equal(repeated.results[0]?.outcome, "APPLIED");
    assert.equal((await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get()).size, 1);
    assert.equal((await db.collection(LAUNCH1000_APPLY_OPERATIONS_COLLECTION).doc(applied.operationId).get()).data()?.completedCount, 1);
  });
});

test("live-equivalent dry-run ignores stale review flags but protects a real live linkage", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const staleProductId = `product-${randomUUID()}`;
    const liveProductId = `product-${randomUUID()}`;
    await db.collection("categories").doc("test-category").set({
      name: "Test Category",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", slug: "test-subcategory", isActive: true, taxonomyCandidate: false }],
    });
    const staleRecord = queueRecordFor(staleProductId, "2026-10-10T00:00:00.000Z");
    staleRecord.productPayload = {
      ...staleRecord.productPayload,
      isActive: true,
      published: true,
      approved: true,
    } as typeof staleRecord.productPayload;
    const liveRecord = queueRecordFor(liveProductId, "2026-10-10T00:00:00.000Z");
    liveRecord.productPayload = {
      ...liveRecord.productPayload,
      isActive: true,
      published: true,
      approved: true,
    } as typeof liveRecord.productPayload;
    await db.collection("supplier_review_queue").doc(staleProductId).set(staleRecord);
    await db.collection("supplier_review_queue").doc(liveProductId).set(liveRecord);
    await db.collection("products").doc(liveProductId).set({ id: liveProductId, isActive: true, visible: true });

    const snapshot = loadLaunch1000SnapshotFromValues({
      manifestRevision: "manifest-test-r1",
      entries: [
        { ...snapshotFor(staleProductId).entries[0]!, productId: staleProductId },
        { ...snapshotFor(liveProductId).entries[0]!, productId: liveProductId },
      ],
    }, { revision: "taxonomy-test-r1", governanceStatus: "PENDING_ADMIN_APPROVAL", proposals: [] });
    const dryRun = await dryRunLaunch1000ProductApply(db, {
      manifestRevision: "manifest-test-r1",
      productIds: [staleProductId, liveProductId],
    }, snapshot);
    const byId = new Map(dryRun.results.map((result) => [result.productId, result]));
    assert.equal(byId.get(staleProductId)?.outcome, "ELIGIBLE");
    assert.equal(byId.get(staleProductId)?.reasonCodes.includes("LIVE_EQUIVALENT"), false);
    assert.equal(byId.get(liveProductId)?.outcome, "NEEDS_ATTENTION");
    assert.equal(byId.get(liveProductId)?.reasonCodes.includes("LIVE_EQUIVALENT"), true);
  });
});

test("invalid apply remains Needs Attention without queue mutation", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `product-${randomUUID()}`;
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    const queueRecord = queueRecordFor(productId, "2026-10-10T00:00:00.000Z");
    await db.collection("categories").doc("test-category").set({
      name: "Test Category", isActive: true, taxonomyCandidate: false, specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", isActive: true, taxonomyCandidate: false }],
    });
    await queueReference.set({ ...queueRecord, managedMedia: [], mediaStatus: "failed", mediaQueueClass: "failed" });
    const snapshot = snapshotFor(productId);
    const before = (await queueReference.get()).data();
    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision: "manifest-test-r1", productIds: [productId] }, snapshot);
    assert.equal(dryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    const operationId = `operation-${randomUUID()}`;
    const result = await applyLaunch1000ProductPilot(db, {
      manifestRevision: "manifest-test-r1",
      productIds: [productId],
      operationId,
      preconditions: {
        [productId]: {
          expectedUpdatedAt: dryRun.results[0]?.expectedUpdatedAt || "",
          expectedFingerprint: dryRun.results[0]?.expectedFingerprint || "",
        },
      },
    }, operator, snapshot);
    assert.equal(result.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.deepEqual((await queueReference.get()).data(), before);
    const audits = await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get();
    assert.equal(audits.docs.filter((document) => document.data().operationId === operationId).length, 1);
  });
});

test("stale product apply is rejected without queue mutation and records a skip audit", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `product-${randomUUID()}`;
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    const queueRecord = queueRecordFor(productId, "2026-10-10T00:00:00.000Z");
    await db.collection("categories").doc("test-category").set({
      name: "Test Category", isActive: true, taxonomyCandidate: false, specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", isActive: true, taxonomyCandidate: false }],
    });
    await queueReference.set(queueRecord);
    const snapshot = snapshotFor(productId);
    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision: "manifest-test-r1", productIds: [productId] }, snapshot);
    await queueReference.update({ updatedAt: "2026-10-10T00:01:00.000Z" });
    const operationId = `operation-${randomUUID()}`;
    const result = await applyLaunch1000ProductPilot(db, {
      manifestRevision: "manifest-test-r1",
      productIds: [productId],
      operationId,
      preconditions: {
        [productId]: {
          expectedUpdatedAt: dryRun.results[0]?.expectedUpdatedAt || "",
          expectedFingerprint: dryRun.results[0]?.expectedFingerprint || "",
        },
      },
    }, operator, snapshot);
    assert.equal(result.results[0]?.outcome, "STALE_OR_CONFLICT");
    const after = (await queueReference.get()).data() || {};
    assert.equal((after.productPayload || {}).category, "");
    const staleAudits = await db.collection(LAUNCH1000_APPLY_AUDIT_COLLECTION).get();
    assert.equal(staleAudits.docs.filter((document) => document.data().operationId === operationId).length, 1);
  });
});

test("apply preconditions use the same record fingerprint exposed by dry-run", () => {
  const record = queueRecordFor("fingerprint-product", "2026-10-10T00:00:00.000Z");
  assert.equal(typeof launch1000RecordFingerprint(record), "string");
  assert.equal(launch1000RecordFingerprint(record), launch1000RecordFingerprint({ ...record }));
});
