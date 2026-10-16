import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  approveMissingParentCategoryProposal,
  createApprovedLaunch1000TaxonomyProposal,
  createApprovedMissingParentCategory,
  launch1000MissingParentProposalId,
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

test("missing parent category endpoints retain Supplier Hub Admin and global App Check boundaries", () => {
  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.match(routes, /app\.post\("\/api\/launch1000\/taxonomy\/parent\/approve", requireSupplierHubAdmin/u);
  assert.match(routes, /app\.post\("\/api\/launch1000\/taxonomy\/parent\/create", requireSupplierHubAdmin/u);
  const app = readFileSync("functions/src/api/app.ts", "utf8");
  assert.ok(app.indexOf("app.use(async (req, res, next) => {") < app.indexOf("registerSupplierRoutes(app);"));
  assert.match(app, /adminAppCheck\.verifyToken\(token\)/u);
});

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

const parentQueueRecordFor = (productId: string, updatedAt: string, pendingRevision = "supplier-offer-revision-1") => ({
  ...queueRecordFor(productId, updatedAt),
  supplierOfferPendingRevision: pendingRevision,
  supplierSnapshot: {
    ...queueRecordFor(productId, updatedAt).supplierSnapshot,
    productPayload: {
      name: "Industrial 3D Printer Filament",
      description: "A spool of thermoplastic filament for compatible 3D printers.",
    },
  },
});

const withEmulator = async (callback: (db: Firestore) => Promise<void>): Promise<void> => {
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "demo-zyro-launch1000" }, `launch1000-${randomUUID()}`);
  try {
    await callback(getFirestore(app));
  } finally {
    await deleteApp(app);
  }
};

const launch800PilotExpectations = [
  { productId: "dropex-aju0011", categoryId: "automotive", subcategoryId: "exterior-accessories", productType: null },
  { productId: "dropex-aju0014", categoryId: "automotive", subcategoryId: "exterior-accessories", productType: null },
  { productId: "dropex-ajuch-3416", categoryId: "health-beauty", subcategoryId: "massage-wellness", productType: null },
  { productId: "dropex-asn0034", categoryId: "automotive", subcategoryId: "exterior-accessories", productType: null },
  { productId: "dropex-asn0036", categoryId: "automotive", subcategoryId: "exterior-accessories", productType: null },
  { productId: "dropex-asn0158", categoryId: "automotive", subcategoryId: "exterior-accessories", productType: null },
  { productId: "dropex-atf0375", categoryId: "electronics", subcategoryId: "smart-watches", productType: "smart watch" },
  { productId: "dropex-atf0376", categoryId: "electronics", subcategoryId: "smart-watches", productType: "smart watch" },
  { productId: "dropex-atf0487", categoryId: "health-beauty", subcategoryId: "hair-care", productType: null },
  { productId: "dropex-atfch-376", categoryId: "health-beauty", subcategoryId: "hair-styling", productType: null },
] as const;

test("Launch-1000 snapshot is immutable, bounded, and proposal references are separate from manifest revision", () => {
  const snapshot = loadLaunch1000Snapshot();
  assert.equal(snapshot.entries.length, 800);
  assert.equal(snapshot.taxonomyProposals.length, 26);
  assert.equal(snapshot.entries.filter((entry) => entry.taxonomyProposalId).length, 451);
  assert.equal(snapshot.taxonomyProposals[0]?.revision, "launch1000-taxonomy-r1");
  assert.equal(snapshot.manifestRevision, "launch1000-final800-visual-freeze-r1");
  assert.notEqual(snapshot.manifestRevision, snapshot.taxonomyProposals[0]?.revision);
});

test("selected Launch-800 Pilot-10 entries use existing taxonomy and bounded deterministic normalization", () => {
  const snapshot = loadLaunch1000Snapshot();
  const matchedProductIds = launch800PilotExpectations.map((expectation) => {
    const entry = snapshot.entries.find((candidate) => candidate.productId === expectation.productId);
    assert.ok(entry, `Missing frozen manifest entry for ${expectation.productId}`);
    assert.equal(entry.sku, expectation.productId);
    assert.equal(entry.sourcePool, "existing-safe");
    assert.equal(entry.taxonomyDecisionSource, "existing-safe");
    assert.equal(entry.taxonomyProposalId, null);
    assert.equal(entry.parentCategoryId, expectation.categoryId);
    assert.equal(entry.subcategoryId, expectation.subcategoryId);
    assert.deepEqual(entry.deterministicSpecNormalization, expectation.productType
      ? { "Product Type": expectation.productType }
      : {});
    return entry.productId;
  });
  assert.deepEqual(matchedProductIds, launch800PilotExpectations.map((expectation) => expectation.productId));
});

test("selected Launch-800 Pilot-10 dry-run is zero-write and accepts only evidenced smart watch normalization", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const categories = new Map<string, string[]>([
      ["automotive", ["exterior-accessories"]],
      ["electronics", ["smart-watches"]],
      ["health-beauty", ["massage-wellness", "hair-care", "hair-styling"]],
    ]);
    for (const [categoryId, subcategoryIds] of categories) {
      await db.collection("categories").doc(categoryId).set({
        name: categoryId,
        isActive: true,
        taxonomyCandidate: false,
        specificationTemplate: [],
        subcategories: subcategoryIds.map((id) => ({ id, name: id, isActive: true, taxonomyCandidate: false })),
      });
    }

    const before = new Map<string, Record<string, unknown>>();
    for (const expectation of launch800PilotExpectations) {
      const record = queueRecordFor(expectation.productId, "2026-10-10T00:00:00.000Z");
      record.productPayload.name = expectation.productType ? `Wireless ${expectation.productType}` : `Managed ${expectation.productId}`;
      record.productPayload.description = expectation.productType ? "A genuine smart watch with managed media." : "A complete managed product with existing taxonomy.";
      await db.collection("supplier_review_queue").doc(expectation.productId).set(record);
      before.set(expectation.productId, record);
    }

    const snapshot = loadLaunch1000Snapshot();
    const dryRun = await dryRunLaunch1000ProductApply(db, {
      manifestRevision: snapshot.manifestRevision,
      productIds: launch800PilotExpectations.map((expectation) => expectation.productId),
    }, snapshot);
    assert.equal(dryRun.results.length, launch800PilotExpectations.length);
    for (let index = 0; index < launch800PilotExpectations.length; index += 1) {
      const expectation = launch800PilotExpectations[index];
      const result = dryRun.results[index];
      assert.equal(result?.productId, expectation.productId);
      assert.equal(result?.outcome, "ELIGIBLE", JSON.stringify(result));
      assert.deepEqual(result?.intendedTaxonomy, {
        categoryId: expectation.categoryId,
        subcategoryId: expectation.subcategoryId,
        proposalId: null,
      });
      assert.deepEqual(result?.deterministicSpecNormalization, expectation.productType
        ? { "Product Type": expectation.productType }
        : {});
      assert.equal(result?.reasonCodes.includes("SPEC_EVIDENCE_MISSING"), false);
      assert.deepEqual((await db.collection("supplier_review_queue").doc(expectation.productId).get()).data(), before.get(expectation.productId));
    }

  });
});

test("deterministic smart watch normalization fails closed for missing or contradictory evidence", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    await db.collection("categories").doc("electronics").set({
      name: "Electronics",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "smart-watches", name: "Smart Watches", isActive: true, taxonomyCandidate: false }],
    });
    for (const [index, description] of ["A wearable storage case.", "Not a smart watch; this is a storage case."].entries()) {
      const record = queueRecordFor("dropex-atf0375", `2026-10-10T00:0${index}:00.000Z`);
      record.productPayload.name = "Generic wearable accessory";
      record.productPayload.description = description;
      await db.collection("supplier_review_queue").doc("dropex-atf0375").set(record);
      const before = (await db.collection("supplier_review_queue").doc("dropex-atf0375").get()).data();
      const snapshot = loadLaunch1000Snapshot();
      const dryRun = await dryRunLaunch1000ProductApply(db, {
        manifestRevision: snapshot.manifestRevision,
        productIds: ["dropex-atf0375"],
      }, snapshot);
      assert.equal(dryRun.results[0]?.outcome, "NEEDS_ATTENTION");
      assert.equal(dryRun.results[0]?.reasonCodes.includes("SPEC_EVIDENCE_MISSING"), true);
      assert.deepEqual((await db.collection("supplier_review_queue").doc("dropex-atf0375").get()).data(), before);
      await db.collection("supplier_review_queue").doc("dropex-atf0375").delete();
    }
  });
});

test("selected Launch-800 Pilot-10 fails closed for missing or inactive canonical taxonomy", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = "dropex-aju0011";
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    const categoryReference = db.collection("categories").doc("automotive");
    const queueRecord = queueRecordFor(productId, "2026-10-10T00:00:00.000Z");
    await queueReference.set(queueRecord);
    await categoryReference.delete();
    const snapshot = loadLaunch1000Snapshot();
    const runDryRun = () => dryRunLaunch1000ProductApply(db, {
      manifestRevision: snapshot.manifestRevision,
      productIds: [productId],
    }, snapshot);

    let dryRun = await runDryRun();
    assert.equal(dryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.equal(dryRun.results[0]?.reasonCodes.includes("CATEGORY_INVALID_OR_INACTIVE"), true);

    await categoryReference.set({
      name: "Automotive",
      isActive: false,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "exterior-accessories", name: "Exterior Accessories", isActive: true, taxonomyCandidate: false }],
    });
    dryRun = await runDryRun();
    assert.equal(dryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.equal(dryRun.results[0]?.reasonCodes.includes("CATEGORY_INVALID_OR_INACTIVE"), true);

    await categoryReference.set({
      name: "Automotive",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "exterior-accessories", name: "Exterior Accessories", isActive: false, taxonomyCandidate: false }],
    });
    dryRun = await runDryRun();
    assert.equal(dryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.equal(dryRun.results[0]?.reasonCodes.includes("SUBCATEGORY_INVALID_OR_INACTIVE"), true);
    assert.deepEqual((await queueReference.get()).data(), queueRecord);
  });
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
    assert.equal(preview.proposals[0]?.parentCategoryLabel, "Test Category");
    assert.equal(preview.proposals[0]?.proposedLabel, "Test Subcategory");
    assert.equal(preview.proposals[0]?.proposedSlug, "test-subcategory");

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
    assert.equal(after.businessQueueClassesVersion, 3);
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

test("missing parent category approval and creation are bounded, auditable, and idempotent", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `parent-product-${randomUUID()}`;
    const updatedAt = "2026-10-10T00:00:00.000Z";
    const queueRecord = parentQueueRecordFor(productId, updatedAt);
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    await queueReference.set(queueRecord);
    const input = {
      queueItemId: productId,
      expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
      expectedUpdatedAt: updatedAt,
      expectedFingerprint: launch1000RecordFingerprint(queueRecord),
      proposedName: "3D Printer Filament Variant",
      proposedSlug: "3d-printer-filament-variant",
      proposedSubcategoryName: "",
      proposedSubcategorySlug: "",
      evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
      adminConfirmed: true as const,
    };
    const approved = await approveMissingParentCategoryProposal(db, input, operator);
    assert.equal(approved.status, "APPROVED");
    const concurrentApprovals = await Promise.all([
      approveMissingParentCategoryProposal(db, input, operator),
      approveMissingParentCategoryProposal(db, input, operator),
    ]);
    assert.equal(concurrentApprovals.every((result) => result.status === "APPROVED"), true);
    assert.equal(concurrentApprovals.some((result) => result.idempotent === true), true);
    const created = await createApprovedMissingParentCategory(db, {
      proposalId: approved.proposalId,
      proposalRevision: approved.proposalRevision,
    }, operator);
    assert.equal(created.status, "CREATED");
    assert.equal(created.createdCategoryId, "3d-printer-filament-variant");
    const createdAgain = await createApprovedMissingParentCategory(db, {
      proposalId: approved.proposalId,
      proposalRevision: approved.proposalRevision,
    }, operator);
    assert.equal(createdAgain.idempotent, true);
    assert.equal((await db.collection("categories").doc("3d-printer-filament-variant").get()).data()?.name, "3D Printer Filament Variant");
    const parentAudits = (await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).get()).docs
      .filter((document) => document.data().proposalId === approved.proposalId);
    assert.equal(parentAudits.length, 2);
    assert.equal((await queueReference.get()).data()?.productPayload.category, "");
  });
});

test("missing parent category creation fails closed after supplier evidence changes", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `stale-parent-product-${randomUUID()}`;
    const updatedAt = "2026-10-10T00:00:00.000Z";
    const queueRecord = parentQueueRecordFor(productId, updatedAt);
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    await queueReference.set(queueRecord);
    const input = {
      queueItemId: productId,
      expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
      expectedUpdatedAt: updatedAt,
      expectedFingerprint: launch1000RecordFingerprint(queueRecord),
      proposedName: "3D Printer Filament",
      proposedSlug: "3d-printer-filament",
      proposedSubcategoryName: "",
      proposedSubcategorySlug: "",
      evidenceRefs: ["supplierSnapshot.productPayload.name"],
      adminConfirmed: true as const,
    };
    const approved = await approveMissingParentCategoryProposal(db, input, operator);
    await queueReference.update({
      updatedAt: "2026-10-10T00:01:00.000Z",
      supplierSnapshot: {
        ...queueRecord.supplierSnapshot,
        productPayload: { name: "Unrelated Household Item", description: "No printer evidence remains." },
      },
    });
    await assert.rejects(
      () => createApprovedMissingParentCategory(db, { proposalId: approved.proposalId, proposalRevision: approved.proposalRevision }, operator),
      /changed|stale|evidence/iu,
    );
    assert.equal((await db.collection("categories").doc("3d-printer-filament").get()).exists, false);
    const staleParentAudits = (await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).get()).docs
      .filter((document) => document.data().proposalId === approved.proposalId);
    assert.equal(staleParentAudits.length, 1);
  });
});

test("missing parent category evidence rejects qualified and punctuated contradictions", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const descriptions = [
      "Not a 3D Printer Filament; this is a household storage item.",
      "Not an 3D Printer Filament; this is a household storage item.",
      "Not 3D Printer Filament; this is a household storage item.",
      "No 3D Printer Filament; this is a household storage item.",
      "Without 3D Printer Filament; this is a household storage item.",
      "Instead of 3D Printer Filament, this is a household storage item.",
      "Not, the actual 3D Printer Filament; this is a household storage item.",
    ];
    for (const description of descriptions) {
      const productId = `contradictory-parent-product-${randomUUID()}`;
      const updatedAt = "2026-10-10T00:00:00.000Z";
      const queueRecord = parentQueueRecordFor(productId, updatedAt);
      queueRecord.supplierSnapshot.productPayload.description = description;
      await db.collection("supplier_review_queue").doc(productId).set(queueRecord);
      await assert.rejects(
        () => approveMissingParentCategoryProposal(db, {
          queueItemId: productId,
          expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
          expectedUpdatedAt: updatedAt,
          expectedFingerprint: launch1000RecordFingerprint(queueRecord),
          proposedName: "3D Printer Filament",
          proposedSlug: "3d-printer-filament",
          proposedSubcategoryName: "",
          proposedSubcategorySlug: "",
          evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
          adminConfirmed: true as const,
        }, operator),
        /contradict/iu,
      );
      assert.equal((await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).get()).docs
        .some((document) => document.data().queueItemId === productId), false);
    }
  });
});

test("missing parent approval rolls back when its deterministic audit write collides", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `parent-approval-audit-failure-${randomUUID()}`;
    const updatedAt = "2026-10-10T00:00:00.000Z";
    const queueRecord = parentQueueRecordFor(productId, updatedAt);
    const expectedFingerprint = launch1000RecordFingerprint(queueRecord);
    const proposalId = launch1000MissingParentProposalId(productId, expectedFingerprint);
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    await queueReference.set(queueRecord);
    await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).doc(`parent-approve-${proposalId}`).set({ occupied: true });
    await assert.rejects(() => approveMissingParentCategoryProposal(db, {
      queueItemId: productId,
      expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
      expectedUpdatedAt: updatedAt,
      expectedFingerprint,
      proposedName: "3D Printer Filament",
      proposedSlug: "3d-printer-filament",
      proposedSubcategoryName: "",
      proposedSubcategorySlug: "",
      evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
      adminConfirmed: true as const,
    }, operator));
    assert.equal((await db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(proposalId).get()).exists, false);
    assert.equal((await db.collection("categories").doc("3d-printer-filament").get()).exists, false);
  });
});

test("missing parent creation rolls back category and governance when its audit write collides", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `parent-creation-audit-failure-${randomUUID()}`;
    const updatedAt = "2026-10-10T00:00:00.000Z";
    const queueRecord = parentQueueRecordFor(productId, updatedAt);
    const expectedFingerprint = launch1000RecordFingerprint(queueRecord);
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    await queueReference.set(queueRecord);
    const approved = await approveMissingParentCategoryProposal(db, {
      queueItemId: productId,
      expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
      expectedUpdatedAt: updatedAt,
      expectedFingerprint,
      proposedName: "3D Printer Filament",
      proposedSlug: "3d-printer-filament",
      proposedSubcategoryName: "",
      proposedSubcategorySlug: "",
      evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
      adminConfirmed: true as const,
    }, operator);
    await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).doc(`parent-create-${approved.proposalId}`).set({ occupied: true });
    await assert.rejects(() => createApprovedMissingParentCategory(db, {
      proposalId: approved.proposalId,
      proposalRevision: approved.proposalRevision,
    }, operator));
    assert.equal((await db.collection("categories").doc("3d-printer-filament").get()).exists, false);
    assert.equal((await db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(approved.proposalId).get()).data()?.status, "APPROVED");
  });
});

test("concurrent missing parent creation attempts produce one category and deterministic audits", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const productId = `parent-concurrent-creation-${randomUUID()}`;
    const updatedAt = "2026-10-10T00:00:00.000Z";
    const queueRecord = parentQueueRecordFor(productId, updatedAt);
    await db.collection("supplier_review_queue").doc(productId).set(queueRecord);
    const approved = await approveMissingParentCategoryProposal(db, {
      queueItemId: productId,
      expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
      expectedUpdatedAt: updatedAt,
      expectedFingerprint: launch1000RecordFingerprint(queueRecord),
      proposedName: "3D Printer Filament",
      proposedSlug: "3d-printer-filament",
      proposedSubcategoryName: "",
      proposedSubcategorySlug: "",
      evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
      adminConfirmed: true as const,
    }, operator);
    const results = await Promise.all([
      createApprovedMissingParentCategory(db, { proposalId: approved.proposalId, proposalRevision: approved.proposalRevision }, operator),
      createApprovedMissingParentCategory(db, { proposalId: approved.proposalId, proposalRevision: approved.proposalRevision }, operator),
    ]);
    assert.equal(results.every((result) => result.status === "CREATED"), true);
    assert.equal(results.some((result) => result.idempotent === true), true);
    assert.equal((await db.collection("categories").doc("3d-printer-filament").get()).exists, true);
    assert.equal((await db.collection(LAUNCH1000_TAXONOMY_GOVERNANCE_COLLECTION).doc(approved.proposalId).get()).data()?.status, "CREATED");
    const audits = (await db.collection(LAUNCH1000_TAXONOMY_AUDIT_COLLECTION).get()).docs
      .filter((document) => document.data().proposalId === approved.proposalId);
    assert.equal(audits.length, 2);
  });
});

test("selected Smart Watch Apply remains review-only and persists deterministic Product Type", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    await db.collection("categories").doc("electronics").set({
      name: "Electronics",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "smart-watches", name: "Smart Watches", isActive: true, taxonomyCandidate: false }],
    });
    const queueRecord = queueRecordFor("dropex-atf0375", "2026-10-10T00:00:00.000Z");
    queueRecord.productPayload.name = "Wireless smart watch";
    queueRecord.productPayload.description = "A genuine smart watch with managed media.";
    await db.collection("supplier_review_queue").doc("dropex-atf0375").set(queueRecord);
    const snapshot = loadLaunch1000Snapshot();
    const dryRun = await dryRunLaunch1000ProductApply(db, {
      manifestRevision: snapshot.manifestRevision,
      productIds: ["dropex-atf0375"],
    }, snapshot);
    assert.equal(dryRun.results[0]?.outcome, "ELIGIBLE");
    const applied = await applyLaunch1000ProductPilot(db, {
      manifestRevision: snapshot.manifestRevision,
      productIds: ["dropex-atf0375"],
      operationId: `launch800-pilot10-${randomUUID()}`,
      preconditions: {
        "dropex-atf0375": {
          expectedUpdatedAt: dryRun.results[0]?.expectedUpdatedAt || "",
          expectedFingerprint: dryRun.results[0]?.expectedFingerprint || "",
        },
      },
    }, operator, snapshot);
    assert.equal(applied.results[0]?.outcome, "APPLIED");
    const appliedRecord = (await db.collection("supplier_review_queue").doc("dropex-atf0375").get()).data() || {};
    const appliedPayload = appliedRecord.productPayload as Record<string, unknown>;
    assert.equal(appliedPayload.productType, "smart watch");
    assert.equal((appliedPayload.specs as Record<string, unknown>)["Product Type"], "smart watch");
    assert.equal((appliedRecord.launch1000Apply as Record<string, unknown>).outcome, "READY_FOR_REVIEW");
    assert.equal(appliedPayload.visible, false);
    assert.equal((await db.collection("products").doc("dropex-atf0375").get()).exists, false);
  });
});
