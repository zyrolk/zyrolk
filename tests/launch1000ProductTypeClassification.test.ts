import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  approveLaunch1000ProductTypeClassification,
  launch1000ProductTypeClassificationAuditEventId,
  launch1000ProductTypeSourceEvidenceFingerprint,
  parseLaunch1000ProductTypeClassificationInput,
} from "../functions/src/api/launch1000/launch1000ProductTypeClassification";
import {
  applyLaunch1000ProductPilot,
  dryRunLaunch1000ProductApply,
} from "../functions/src/api/launch1000/launch1000Apply";
import {
  launch1000RecordFingerprint,
  loadLaunch1000SnapshotFromValues,
} from "../functions/src/api/launch1000/launch1000Snapshot";
import {
  buildSupplierOfferId,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "../functions/src/api/suppliers/supplierOfferEngine";

const canRunFirestore = /^(127\.0\.0\.1|localhost):\d+$/u.test(String(process.env.FIRESTORE_EMULATOR_HOST || "").trim())
  && String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "demo-zyro-launch1000").startsWith("demo-");

const operator = { uid: "classification-test-admin", email: "classification-test@example.invalid" };
const productId = "dropex-aju0010";
const productType = "audio device";
const manifestRevision = "launch1000-final800-visual-freeze-r1";
const pendingRevision = "a".repeat(64);
const updatedAt = "2026-10-10T00:00:00.000Z";
const imageHash = "b".repeat(64);

const snapshot = loadLaunch1000SnapshotFromValues({
  manifestRevision,
  entries: [{
    productId,
    sku: `${productId}-sku`,
    sourcePool: "existing-safe",
    sourceCluster: "test-cluster",
    taxonomyDecisionSource: "trusted-existing-taxonomy",
    parentCategoryId: "test-category",
    parentCategoryLabel: "Test Category",
    subcategoryId: "test-subcategory",
    subcategoryLabel: "Test Subcategory",
    taxonomyProposalId: null,
    deterministicSpecNormalization: { "Product Type": productType },
    launchPriority: 1,
    validatorCertificationState: "CERTIFIED_CLEAN",
    visualCertificationState: "VISUAL_MATCH",
  }],
}, {
  revision: "taxonomy-test-r1",
  governanceStatus: "PENDING_ADMIN_APPROVAL",
  proposals: [],
});

const queueRecord = () => ({
  status: "Pending",
  queueState: "review_pending",
  reviewStatus: "Pending",
  sourceId: "dropex",
  supplierProductId: "aju0010",
  supplierCode: "aju0010",
  canonicalProductId: productId,
  productId,
  supplierOfferPendingRevision: pendingRevision,
  updatedAt,
  comparisonStatus: "NEW_PRODUCT",
  comparison: { comparisonStatus: "NEW_PRODUCT", changedFields: [], matchedProductLive: false },
  productPayload: {
    id: productId,
    name: "Bluetooth audio subwoofer",
    description: "A compact audio product for home listening.",
    price: 20,
    costPrice: 10,
    stock: 8,
    category: "test-category",
    subcategory: "test-subcategory",
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
    supplierProductId: "aju0010",
    productPayload: { name: "Bluetooth audio subwoofer" },
    supplierMetadata: { supplierStockAvailable: true, supplierCostAvailable: true },
  },
  managedMedia: [{
    contentHash: imageHash,
    firebaseStorageUrl: "https://firebasestorage.googleapis.com/v0/b/demo/o/managed.webp?alt=media",
    originalSupplierUrl: "https://supplier.example/managed.webp",
    imageStatus: "ready",
    isPrimary: true,
    sortOrder: 0,
    storagePath: "supplier-review/test/managed.webp",
  }],
  mediaStatus: "ready",
  mediaQueueClass: "ready",
  mediaSourceImageUrls: ["https://supplier.example/managed.webp"],
  mediaFailures: [],
  supplierSyncState: { batchId: "sync-before", state: "pending", revision: "sync-1" },
  productValidation: { readyToPublish: false, missingFields: ["specs.Product Type"], errors: [{ field: "specs.Product Type", code: "required", message: "required" }] },
});

type PilotCase = { productId: string; productType: string; title: string };

const pilotCases: readonly PilotCase[] = [
  { productId: "dropex-adl0019", productType: "tool or hardware", title: "2Pcs Cabinet Jack Support 60 5Ft" },
  { productId: "dropex-aju0010", productType: "audio device", title: "BTS 1321 3 Subwoofer" },
  { productId: "dropex-aju0013", productType: "audio device", title: "Air Max Display Earbuds" },
  { productId: "dropex-aju0021", productType: "audio device", title: "Large Display Earbuds" },
  { productId: "dropex-aju0027", productType: "household product", title: "Multi Purpose Cleaning Brush" },
  { productId: "dropex-ajuch-3338", productType: "household product", title: "Indomitable Clothes Rack" },
] ;

const queueRecordFor = (entry: PilotCase, queueItemId = entry.productId) => {
  const base = queueRecord();
  const supplierProductId = `supplier-${entry.productId}`;
  return {
    ...base,
    supplierProductId,
    supplierCode: supplierProductId,
    canonicalProductId: entry.productId,
    productId: entry.productId,
    productPayload: {
      ...(base.productPayload as Record<string, unknown>),
      id: entry.productId,
      name: entry.title,
      description: entry.title,
    },
    supplierSnapshot: {
      ...(base.supplierSnapshot as Record<string, unknown>),
      supplierProductId,
      productPayload: { name: entry.title },
    },
    queueItemId,
  };
};

const manifestEntryFor = (entry: PilotCase) => ({
  productId: entry.productId,
  sku: entry.productId,
  sourcePool: "existing-safe" as const,
  sourceCluster: "test-cluster",
  taxonomyDecisionSource: "trusted-existing-taxonomy",
  parentCategoryId: "test-category",
  parentCategoryLabel: "Test Category",
  subcategoryId: "test-subcategory",
  subcategoryLabel: "Test Subcategory",
  taxonomyProposalId: null,
  deterministicSpecNormalization: { "Product Type": entry.productType },
  launchPriority: 1,
  validatorCertificationState: "CERTIFIED_CLEAN",
  visualCertificationState: "VISUAL_MATCH",
});

const snapshotFor = (...entries: PilotCase[]) => loadLaunch1000SnapshotFromValues({
  manifestRevision,
  entries: entries.map(manifestEntryFor),
}, {
  revision: "taxonomy-test-r1",
  governanceStatus: "PENDING_ADMIN_APPROVAL",
  proposals: [],
});

const withEmulator = async (callback: (db: Firestore) => Promise<void>): Promise<void> => {
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "demo-zyro-launch1000" }, `launch1000-classification-${randomUUID()}`);
  try {
    const db = getFirestore(app);
    for (const collectionName of [
      "supplier_review_queue",
      "supplier_product_offers",
      "supplier_approval_audit",
      "categories",
      "products",
    ]) {
      const existing = await db.collection(collectionName).get();
      await Promise.all(existing.docs.map((document) => document.ref.delete()));
    }
    await callback(db);
  } finally {
    await deleteApp(app);
  }
};

const inputFor = (record: Record<string, unknown>, overrides: Record<string, unknown> = {}) => parseLaunch1000ProductTypeClassificationInput({
  decision: "approve",
  confirmed: true,
  manifestRevision,
  productType,
  evidence: [
    { kind: "product_title", ref: "productPayload.name" },
    { kind: "managed_image", ref: `managedMedia:${imageHash}` },
  ],
  rationale: "The genuine product title and managed image identify an audio product.",
  expectedPendingRevision: pendingRevision,
  expectedUpdatedAt: updatedAt,
  expectedFingerprint: launch1000RecordFingerprint(record),
  ...overrides,
});

const inputForPilot = (
  record: Record<string, unknown>,
  entry: PilotCase,
  evidence: Array<Record<string, string>> = [{ kind: "product_title", ref: "productPayload.name" }],
  overrides: Record<string, unknown> = {},
) => parseLaunch1000ProductTypeClassificationInput({
  decision: "approve",
  confirmed: true,
  manifestRevision,
  productType: entry.productType,
  evidence,
  rationale: "The supplier title contains the product-specific identifying terms.",
  expectedPendingRevision: pendingRevision,
  expectedUpdatedAt: updatedAt,
  expectedFingerprint: launch1000RecordFingerprint(record),
  ...overrides,
});

test("Product Type classification parser enforces the exact decision shape", () => {
  assert.throws(() => parseLaunch1000ProductTypeClassificationInput({
    decision: "approve",
    manifestRevision,
    productType,
    evidence: [{ kind: "product_title", ref: "productPayload.name" }],
    rationale: "The product title supplies enough evidence for this classification.",
    expectedPendingRevision: pendingRevision,
    expectedUpdatedAt: updatedAt,
    expectedFingerprint: "c".repeat(64),
  }), /Explicit Product Type classification confirmation is required/u);
  assert.throws(() => parseLaunch1000ProductTypeClassificationInput({
    decision: "approve",
    confirmed: true,
    manifestRevision,
    productType: "arbitrary technical specification",
    evidence: [{ kind: "product_title", ref: "productPayload.name" }],
    rationale: "short",
    expectedPendingRevision: pendingRevision,
    expectedUpdatedAt: updatedAt,
    expectedFingerprint: "c".repeat(64),
  }), /at least 20 characters/u);
  assert.throws(() => parseLaunch1000ProductTypeClassificationInput({
    decision: "approve",
    confirmed: true,
    manifestRevision,
    productType,
    evidence: [{ kind: "product_title", ref: "productPayload.name" }],
    rationale: "The product title supplies enough evidence for this classification.",
    expectedPendingRevision: pendingRevision,
    expectedUpdatedAt: updatedAt,
    expectedFingerprint: "c".repeat(64),
    arbitraryField: "not accepted",
  }), /unsupported fields/u);
});

test("Product Type classification is atomic, idempotent, review-only, and preserves supplier facts", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    const original = queueRecord();
    await db.collection("categories").doc("test-category").set({
      name: "Test Category",
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [{ name: "Product Type", required: true }],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", isActive: true, taxonomyCandidate: false }],
    });
    await queueReference.set(original);
    const beforeSupplierSnapshot = (await queueReference.get()).data()?.supplierSnapshot;
    const beforeFingerprint = launch1000RecordFingerprint(original);
    const auditQuery = db.collection("supplier_approval_audit").where("queueItemId", "==", productId);
    const beforeAuditCount = (await auditQuery.get()).size;

    const first = await approveLaunch1000ProductTypeClassification(db, productId, inputFor(original), operator, snapshot);
    assert.equal(first.idempotent, false);
    assert.equal(first.classification.source, "zyro-derived");
    assert.equal(first.classification.confirmed, true);
    assert.equal(first.classification.value, productType);
    assert.equal(first.classification.manifestRevision, manifestRevision);
    assert.equal(first.classification.sourceFingerprint, beforeFingerprint);
    assert.equal((first.item.productPayload as Record<string, unknown>).productType, productType);
    assert.deepEqual((first.item.productPayload as Record<string, unknown>).specs, { "Product Type": productType });
    assert.equal(((first.item.productPayload as Record<string, unknown>).supplierFieldOwnership as Record<string, unknown>).productType !== undefined, true);
    assert.equal((first.item.productPayload as Record<string, unknown>).isActive, false);
    assert.equal((first.item.productPayload as Record<string, unknown>).visible, false);
    assert.equal((first.item.productPayload as Record<string, unknown>).price, (original.productPayload as Record<string, unknown>).price);
    assert.equal((first.item.productPayload as Record<string, unknown>).stock, (original.productPayload as Record<string, unknown>).stock);
    assert.deepEqual(first.item.supplierSnapshot, beforeSupplierSnapshot);
    assert.equal((await db.collection("products").doc(productId).get()).exists, false);
    assert.equal((await auditQuery.get()).size, beforeAuditCount + 1);
    assert.equal((await auditQuery.get()).docs[0]?.data().classificationDecision?.confirmed, true);

    const repeated = await approveLaunch1000ProductTypeClassification(db, productId, inputFor(original), operator, snapshot);
    assert.equal(repeated.idempotent, true);
    assert.equal((await auditQuery.get()).size, beforeAuditCount + 1);
    assert.equal((await queueReference.get()).data()?.launch1000ProductTypeClassification?.auditEventId, first.classification.auditEventId);

    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, productId, inputFor(original, { rationale: "A different admin rationale for the same product evidence." }), operator, snapshot),
      /different or stale/u,
    );
    assert.equal((await auditQuery.get()).size, beforeAuditCount + 1);

    const beforeDryRun = (await queueReference.get()).data();
    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [productId] }, snapshot);
    assert.equal(dryRun.results[0]?.outcome, "ELIGIBLE", JSON.stringify(dryRun.results[0]));
    assert.deepEqual((await queueReference.get()).data(), beforeDryRun);
    const precondition = dryRun.results[0];
    const applied = await applyLaunch1000ProductPilot(db, {
      manifestRevision,
      productIds: [productId],
      operationId: `classification-apply-${randomUUID()}`,
      preconditions: {
        [productId]: {
          expectedUpdatedAt: precondition?.expectedUpdatedAt || "",
          expectedFingerprint: precondition?.expectedFingerprint || "",
        },
      },
    }, operator, snapshot);
    assert.equal(applied.results[0]?.outcome, "APPLIED");
    assert.equal((await db.collection("products").doc(productId).get()).exists, false);
    assert.equal((await queueReference.get()).data()?.launch1000Apply?.outcome, "READY_FOR_REVIEW");
    assert.equal((await queueReference.get()).data()?.queueState, "review_pending");
  });
});

test("Product Type classification rejects missing evidence and stale fingerprints without writes", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const queueReference = db.collection("supplier_review_queue").doc(productId);
    const original = queueRecord();
    await db.collection("categories").doc("test-category").set({ isActive: true, taxonomyCandidate: false, specificationTemplate: [], subcategories: [] });
    await queueReference.set(original);
    const auditQuery = db.collection("supplier_approval_audit").where("queueItemId", "==", productId);
    const beforeAuditCount = (await auditQuery.get()).size;
    const missingEvidence = inputFor(original, { evidence: [{ kind: "product_description", ref: "supplierSnapshot.description" }] });
    await assert.rejects(approveLaunch1000ProductTypeClassification(db, productId, missingEvidence, operator, snapshot), /evidence is missing/u);
    await assert.rejects(approveLaunch1000ProductTypeClassification(db, productId, inputFor(original, { expectedFingerprint: "c".repeat(64) }), operator, snapshot), /changed after it was opened/u);
    assert.deepEqual((await queueReference.get()).data(), original);
    assert.equal((await auditQuery.get()).size, beforeAuditCount);
  });
});

test("Product Type classification accepts only product-specific evidence for all six Pilot-10 records", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    await db.collection("categories").doc("test-category").set({ isActive: true, taxonomyCandidate: false, specificationTemplate: [], subcategories: [] });
    const sixProductSnapshot = snapshotFor(...pilotCases);
    for (const entry of pilotCases) {
      const queueItemId = `legacy-${entry.productId}`;
      const record = queueRecordFor(entry, queueItemId);
      await db.collection("supplier_review_queue").doc(queueItemId).set(record);
      const result = await approveLaunch1000ProductTypeClassification(
        db,
        queueItemId,
        inputForPilot(record, entry),
        operator,
        sixProductSnapshot,
      );
      assert.equal(result.classification.value, entry.productType);
      assert.equal(result.classification.identity.canonicalProductId, entry.productId);
      assert.equal(result.classification.identity.resolution, "legacy_fallback");
      assert.equal(result.classification.sourceEvidenceFingerprint, launch1000ProductTypeSourceEvidenceFingerprint(record));
    }
  });
});

test("Product Type classification rejects generic, unrelated, contradictory, missing, and image-only evidence", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const entry = pilotCases[1];
    const classificationSnapshot = snapshotFor(entry);
    await db.collection("categories").doc("test-category").set({ isActive: true, taxonomyCandidate: false, specificationTemplate: [], subcategories: [] });
    const cases = [
      { name: "generic", title: "Item", expected: /does not establish/u },
      { name: "unrelated", title: "Indomitable Clothes Rack", expected: /does not establish/u },
      { name: "contradictory", title: "Subwoofer Earbuds", expected: /contradictory/u },
      { name: "ambiguous", title: "Subwoofer Case", expected: /ambiguous/u },
    ] as const;
    for (const invalidCase of cases) {
      const queueItemId = `invalid-${invalidCase.name}`;
      const record = queueRecordFor({ ...entry, title: invalidCase.title }, queueItemId);
      await db.collection("supplier_review_queue").doc(queueItemId).set(record);
      await assert.rejects(
        approveLaunch1000ProductTypeClassification(db, queueItemId, inputForPilot(record, entry), operator, classificationSnapshot),
        invalidCase.expected,
      );
      assert.equal((await db.collection("supplier_review_queue").doc(queueItemId).get()).data()?.launch1000ProductTypeClassification, undefined);
    }

    const missingQueueItemId = "invalid-missing";
    const missingRecord = queueRecordFor(entry, missingQueueItemId);
    await db.collection("supplier_review_queue").doc(missingQueueItemId).set(missingRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(
        db,
        missingQueueItemId,
        inputForPilot(missingRecord, entry, [{ kind: "product_description", ref: "supplierSnapshot.description" }]),
        operator,
        classificationSnapshot,
      ),
      /evidence is missing/u,
    );

    const imageOnlyQueueItemId = "invalid-image-only";
    const imageOnlyRecord = queueRecordFor(entry, imageOnlyQueueItemId);
    await db.collection("supplier_review_queue").doc(imageOnlyQueueItemId).set(imageOnlyRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(
        db,
        imageOnlyQueueItemId,
        inputForPilot(imageOnlyRecord, entry, [{ kind: "managed_image", ref: `managedMedia:${imageHash}` }]),
        operator,
        classificationSnapshot,
      ),
      /cannot establish Product Type semantics/u,
    );

    const adminEditedQueueItemId = "invalid-admin-edited-evidence";
    const adminEditedBase = queueRecordFor({ ...entry, title: "Subwoofer" }, adminEditedQueueItemId);
    const adminEditedRecord = {
      ...adminEditedBase,
      productPayload: {
        ...(adminEditedBase.productPayload as Record<string, unknown>),
        supplierFieldOwnership: {
          name: {
            owner: "admin",
            sourceId: null,
            updatedAt,
            updatedBy: "admin-reviewer",
            reason: "admin_product_edit",
          },
        },
      },
      supplierSnapshot: {
        ...(adminEditedBase.supplierSnapshot as Record<string, unknown>),
        productPayload: { name: "Generic household item" },
      },
    };
    await db.collection("supplier_review_queue").doc(adminEditedQueueItemId).set(adminEditedRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(
        db,
        adminEditedQueueItemId,
        inputForPilot(adminEditedRecord, entry),
        operator,
        classificationSnapshot,
      ),
      /trustworthy supplier provenance|does not establish|cannot establish Product Type semantics/u,
    );
    assert.equal(
      (await db.collection("supplier_review_queue").doc(adminEditedQueueItemId).get()).data()?.launch1000ProductTypeClassification,
      undefined,
    );
  });
});

test("Product Type classification validates canonical identity, deterministic offers, and legacy queue IDs", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const entry = pilotCases[1];
    const classificationSnapshot = snapshotFor(entry);
    await db.collection("categories").doc("test-category").set({ isActive: true, taxonomyCandidate: false, specificationTemplate: [], subcategories: [] });

    const validQueueItemId = "collision-safe-legacy-queue-id";
    const validRecord = queueRecordFor(entry, validQueueItemId);
    const validSupplierProductId = String(validRecord.supplierProductId);
    const validSupplierSku = String(validRecord.supplierCode);
    const validOfferId = buildSupplierOfferId("dropex", validSupplierProductId, validSupplierSku);
    await db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(validOfferId).set({
      sourceId: "dropex",
      supplierId: "dropex",
      supplierProductId: validSupplierProductId,
      sku: validSupplierSku,
      productId: entry.productId,
      stock: 5,
      price: 10,
      cost: 5,
      lastSyncAt: updatedAt,
      reviewStatus: "review_pending",
    });
    await db.collection("supplier_review_queue").doc(validQueueItemId).set({ ...validRecord, supplierOfferId: validOfferId });
    const validResult = await approveLaunch1000ProductTypeClassification(
      db,
      validQueueItemId,
      inputForPilot({ ...validRecord, supplierOfferId: validOfferId }, entry),
      operator,
      classificationSnapshot,
    );
    assert.equal(validResult.classification.identity.resolution, "deterministic_offer");
    assert.equal(validResult.classification.identity.supplierOfferId, validOfferId);

    const mismatchedQueueItemId = "identity-mismatch";
    const mismatchedRecord = {
      ...queueRecordFor(entry, mismatchedQueueItemId),
      productId: "dropex-aju0013",
      productPayload: { ...(queueRecordFor(entry, mismatchedQueueItemId).productPayload as Record<string, unknown>), id: "dropex-aju0013" },
    };
    await db.collection("supplier_review_queue").doc(mismatchedQueueItemId).set(mismatchedRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, mismatchedQueueItemId, inputForPilot(mismatchedRecord, entry), operator, classificationSnapshot),
      /conflicting canonical product identities/u,
    );

    const unresolvedOfferQueueItemId = "identity-unresolved-offer";
    const unresolvedRecord = { ...queueRecordFor(entry, unresolvedOfferQueueItemId), supplierOfferId: "offer-not-real" };
    await db.collection("supplier_review_queue").doc(unresolvedOfferQueueItemId).set(unresolvedRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, unresolvedOfferQueueItemId, inputForPilot(unresolvedRecord, entry), operator, classificationSnapshot),
      /deterministic supplier offer could not be resolved|could not be found|conflicts with/u,
    );

    const wrongSourceQueueItemId = "identity-wrong-source";
    const wrongSourceBase = queueRecordFor(entry, wrongSourceQueueItemId);
    const wrongSourceRecord = {
      ...wrongSourceBase,
      sourceId: "other-source",
      supplierSnapshot: { ...(wrongSourceBase.supplierSnapshot as Record<string, unknown>), sourceId: "other-source" },
    };
    await db.collection("supplier_review_queue").doc(wrongSourceQueueItemId).set(wrongSourceRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, wrongSourceQueueItemId, inputForPilot(wrongSourceRecord, entry), operator, classificationSnapshot),
      /limited to Dropex/u,
    );

    const missingIdentityQueueItemId = "identity-missing-supplier-product";
    const missingIdentityBase = queueRecordFor(entry, missingIdentityQueueItemId);
    const missingIdentityRecord = {
      ...missingIdentityBase,
      supplierProductId: "",
      supplierCode: "",
      supplierSnapshot: { ...(missingIdentityBase.supplierSnapshot as Record<string, unknown>), supplierProductId: "" },
    };
    await db.collection("supplier_review_queue").doc(missingIdentityQueueItemId).set(missingIdentityRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, missingIdentityQueueItemId, inputForPilot(missingIdentityRecord, entry), operator, classificationSnapshot),
      /supplier product identity is missing/u,
    );
  });
});

test("Launch-1000 consumption revalidates supplier offers and resolves one legacy queue record", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const entry = pilotCases[1];
    const classificationSnapshot = snapshotFor(entry);
    await db.collection("categories").doc("test-category").set({
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", isActive: true, taxonomyCandidate: false }],
    });

    const priorQueueRecords = await db.collection("supplier_review_queue")
      .where("canonicalProductId", "==", entry.productId)
      .get();
    await Promise.all(priorQueueRecords.docs.map((document) => document.ref.delete()));
    const priorProductRecords = await db.collection("supplier_review_queue")
      .where("productId", "==", entry.productId)
      .get();
    await Promise.all(priorProductRecords.docs.map((document) => document.ref.delete()));
    await db.collection("supplier_review_queue").doc(entry.productId).delete();

    const legacyQueueItemId = `legacy-consumption-${randomUUID()}`;
    const legacyRecord = queueRecordFor(entry, legacyQueueItemId);
    const legacySupplierProductId = String(legacyRecord.supplierProductId);
    const legacySupplierSku = String(legacyRecord.supplierCode);
    await db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(
      buildSupplierOfferId("dropex", legacySupplierProductId, legacySupplierSku),
    ).delete();
    await db.collection("supplier_review_queue").doc(legacyQueueItemId).set(legacyRecord);
    const approved = await approveLaunch1000ProductTypeClassification(
      db,
      legacyQueueItemId,
      inputForPilot(legacyRecord, entry),
      operator,
      classificationSnapshot,
    );
    assert.equal(approved.classification.identity.resolution, "legacy_fallback");
    assert.equal(approved.classification.evidenceSnapshot[0]?.provenance, "supplier-observed");

    const beforeDryRun = (await db.collection("supplier_review_queue").doc(legacyQueueItemId).get()).data();
    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(dryRun.results[0]?.outcome, "ELIGIBLE", JSON.stringify(dryRun.results[0]));
    assert.deepEqual((await db.collection("supplier_review_queue").doc(legacyQueueItemId).get()).data(), beforeDryRun);
    assert.equal((await db.collection("supplier_review_queue").doc(entry.productId).get()).exists, false);

    const applied = await applyLaunch1000ProductPilot(db, {
      manifestRevision,
      productIds: [entry.productId],
      operationId: `legacy-consumption-apply-${randomUUID()}`,
      preconditions: {
        [entry.productId]: {
          expectedUpdatedAt: dryRun.results[0]?.expectedUpdatedAt || "",
          expectedFingerprint: dryRun.results[0]?.expectedFingerprint || "",
        },
      },
    }, operator, classificationSnapshot);
    assert.equal(applied.results[0]?.outcome, "APPLIED", JSON.stringify(applied.results[0]));
    assert.equal((await db.collection("supplier_review_queue").doc(legacyQueueItemId).get()).data()?.launch1000Apply?.outcome, "READY_FOR_REVIEW");
    assert.equal((await db.collection("supplier_review_queue").doc(entry.productId).get()).exists, false);
    await db.collection("supplier_review_queue").doc(legacyQueueItemId).delete();

    const offerSupplierProductId = `freshness-${randomUUID()}`;
    const offerSku = `${offerSupplierProductId}-sku`;
    const offerId = buildSupplierOfferId("dropex", offerSupplierProductId, offerSku);
    const freshnessQueueItemId = `offer-freshness-${randomUUID()}`;
    const freshnessRecord = {
      ...queueRecordFor(entry, freshnessQueueItemId),
      supplierProductId: offerSupplierProductId,
      supplierCode: offerSku,
      supplierOfferId: offerId,
      supplierSnapshot: {
        ...(queueRecordFor(entry, freshnessQueueItemId).supplierSnapshot as Record<string, unknown>),
        supplierProductId: offerSupplierProductId,
      },
    };
    await db.collection("supplier_review_queue").doc(freshnessQueueItemId).set(freshnessRecord);
    await db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(offerId).set({
      sourceId: "dropex",
      supplierId: "dropex",
      supplierProductId: offerSupplierProductId,
      sku: offerSku,
      productId: entry.productId,
      stock: 5,
      price: 10,
      cost: 5,
      lastSyncAt: updatedAt,
      reviewStatus: "review_pending",
    });
    const approvedFreshness = await approveLaunch1000ProductTypeClassification(
      db,
      freshnessQueueItemId,
      inputForPilot(freshnessRecord, entry),
      operator,
      classificationSnapshot,
    );
    assert.equal(approvedFreshness.classification.identity.supplierOfferId, offerId);
    const validPrecondition = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(validPrecondition.results[0]?.outcome, "ELIGIBLE");

    await db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(offerId).update({ productId: "dropex-aju0013" });
    const changedOfferDryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(changedOfferDryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.ok(changedOfferDryRun.results[0]?.reasonCodes.includes("SUPPLIER_IDENTITY_CONFLICT"));
    const changedOfferApply = await applyLaunch1000ProductPilot(db, {
      manifestRevision,
      productIds: [entry.productId],
      operationId: `changed-offer-apply-${randomUUID()}`,
      preconditions: {
        [entry.productId]: {
          expectedUpdatedAt: validPrecondition.results[0]?.expectedUpdatedAt || "",
          expectedFingerprint: validPrecondition.results[0]?.expectedFingerprint || "",
        },
      },
    }, operator, classificationSnapshot);
    assert.equal(changedOfferApply.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.equal((await db.collection("products").doc(entry.productId).get()).exists, false);

    await db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(offerId).delete();
    const deletedOfferDryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(deletedOfferDryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.ok(deletedOfferDryRun.results[0]?.reasonCodes.includes("SUPPLIER_IDENTITY_CONFLICT"));

    await db.collection("supplier_review_queue").doc(freshnessQueueItemId).update({ supplierOfferId: "missing-authoritative-offer" });
    const missingOfferDryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(missingOfferDryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.ok(missingOfferDryRun.results[0]?.reasonCodes.includes("SUPPLIER_IDENTITY_CONFLICT"));

    const duplicateQueueItemId = `duplicate-consumption-${randomUUID()}`;
    await db.collection("supplier_review_queue").doc(duplicateQueueItemId).set(queueRecordFor(entry, duplicateQueueItemId));
    const duplicateDryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(duplicateDryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.ok(duplicateDryRun.results[0]?.reasonCodes.includes("SUPPLIER_IDENTITY_CONFLICT"));
  });
});

test("Product Type classification rejects changed source evidence during Apply consumption", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const entry = pilotCases[1];
    const classificationSnapshot = snapshotFor(entry);
    const queueReference = db.collection("supplier_review_queue").doc(entry.productId);
    const original = queueRecordFor(entry);
    await db.collection("categories").doc("test-category").set({
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", isActive: true, taxonomyCandidate: false }],
    });
    await queueReference.set(original);
    const first = await approveLaunch1000ProductTypeClassification(db, entry.productId, inputForPilot(original, entry), operator, classificationSnapshot);
    assert.equal(first.classification.sourceEvidenceFingerprint, launch1000ProductTypeSourceEvidenceFingerprint(original));
    const current = (await queueReference.get()).data() || {};
    await queueReference.update({
      productPayload: { ...(current.productPayload as Record<string, unknown>), name: "Subwoofer Earbuds", description: "Subwoofer Earbuds" },
    });
    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: [entry.productId] }, classificationSnapshot);
    assert.equal(dryRun.results[0]?.outcome, "NEEDS_ATTENTION");
    assert.ok(dryRun.results[0]?.reasonCodes.includes("PRODUCT_TYPE_CLASSIFICATION_STALE"));
  });
});

test("Product Type classification is concurrency-safe and audit creation rolls back the queue decision", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const entry = pilotCases[1];
    const classificationSnapshot = snapshotFor(entry);
    await db.collection("categories").doc("test-category").set({ isActive: true, taxonomyCandidate: false, specificationTemplate: [], subcategories: [] });
    const concurrentQueueItemId = "concurrent-classification";
    const concurrentRecord = queueRecordFor(entry, concurrentQueueItemId);
    await db.collection("supplier_review_queue").doc(concurrentQueueItemId).set(concurrentRecord);
    const concurrentInput = inputForPilot(concurrentRecord, entry);
    const concurrentResults = await Promise.all([
      approveLaunch1000ProductTypeClassification(db, concurrentQueueItemId, concurrentInput, operator, classificationSnapshot),
      approveLaunch1000ProductTypeClassification(db, concurrentQueueItemId, concurrentInput, operator, classificationSnapshot),
    ]);
    assert.equal(concurrentResults.filter((result) => result.idempotent === false).length, 1);
    assert.equal(concurrentResults.filter((result) => result.idempotent === true).length, 1);
    assert.equal((await db.collection("supplier_approval_audit").where("queueItemId", "==", concurrentQueueItemId).get()).size, 1);

    const rollbackQueueItemId = "audit-rollback-classification";
    const rollbackRecord = queueRecordFor(entry, rollbackQueueItemId);
    await db.collection("supplier_review_queue").doc(rollbackQueueItemId).set(rollbackRecord);
    const sourceEvidenceFingerprint = launch1000ProductTypeSourceEvidenceFingerprint(rollbackRecord);
    const auditEventId = launch1000ProductTypeClassificationAuditEventId(rollbackQueueItemId, manifestRevision, sourceEvidenceFingerprint);
    await db.collection("supplier_approval_audit").doc(auditEventId).set({ sentinel: true, queueItemId: rollbackQueueItemId });
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, rollbackQueueItemId, inputForPilot(rollbackRecord, entry), operator, classificationSnapshot),
    );
    const afterRollback = (await db.collection("supplier_review_queue").doc(rollbackQueueItemId).get()).data();
    assert.deepEqual(afterRollback, rollbackRecord);
    assert.deepEqual((await db.collection("supplier_approval_audit").doc(auditEventId).get()).data(), { sentinel: true, queueItemId: rollbackQueueItemId });
  });
});

test("the four historical eligible Pilot-10 products remain eligible and untouched", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const eligibleIds = ["dropex-aju0011", "dropex-aju0014", "dropex-aju0019", "dropex-aju0022"];
    const eligibleSnapshot = loadLaunch1000SnapshotFromValues({
      manifestRevision,
      entries: eligibleIds.map((eligibleId, index) => ({
        productId: eligibleId,
        sku: eligibleId,
        sourcePool: "existing-safe" as const,
        sourceCluster: "historical-pilot-10-eligible",
        taxonomyDecisionSource: "existing-safe",
        parentCategoryId: "test-category",
        parentCategoryLabel: "Test Category",
        subcategoryId: "test-subcategory",
        subcategoryLabel: "Test Subcategory",
        taxonomyProposalId: null,
        deterministicSpecNormalization: {},
        launchPriority: index + 1,
        validatorCertificationState: "CERTIFIED_CLEAN" as const,
        visualCertificationState: "VISUAL_MATCH" as const,
      })),
    }, {
      revision: "taxonomy-test-r1",
      governanceStatus: "PENDING_ADMIN_APPROVAL",
      proposals: [],
    });
    await db.collection("categories").doc("test-category").set({
      isActive: true,
      taxonomyCandidate: false,
      specificationTemplate: [],
      subcategories: [{ id: "test-subcategory", name: "Test Subcategory", isActive: true, taxonomyCandidate: false }],
    });
    const before = new Map<string, Record<string, unknown>>();
    for (const eligibleId of eligibleIds) {
      const record = queueRecordFor({ ...pilotCases[1], productId: eligibleId, title: "Historical eligible Pilot-10 product" }, eligibleId);
      await db.collection("supplier_review_queue").doc(eligibleId).set(record);
      before.set(eligibleId, record);
    }
    const dryRun = await dryRunLaunch1000ProductApply(db, { manifestRevision, productIds: eligibleIds }, eligibleSnapshot);
    assert.deepEqual(dryRun.results.map((result) => result.outcome), ["ELIGIBLE", "ELIGIBLE", "ELIGIBLE", "ELIGIBLE"]);
    for (const eligibleId of eligibleIds) {
      assert.deepEqual((await db.collection("supplier_review_queue").doc(eligibleId).get()).data(), before.get(eligibleId));
    }
  });
});

test("Product Type classification remains limited to the six historical allowlist IDs", { skip: !canRunFirestore }, async () => {
  await withEmulator(async (db) => {
    const invalidRecord = queueRecordFor({ ...pilotCases[1], productId: "dropex-aju0011" }, "dropex-aju0011");
    await db.collection("supplier_review_queue").doc("dropex-aju0011").set(invalidRecord);
    await assert.rejects(
      approveLaunch1000ProductTypeClassification(db, "dropex-aju0011", parseLaunch1000ProductTypeClassificationInput({
        decision: "approve",
        confirmed: true,
        manifestRevision,
        productType,
        evidence: [{ kind: "product_title", ref: "productPayload.name" }],
        rationale: "The product title supplies enough evidence for this classification.",
        expectedPendingRevision: pendingRevision,
        expectedUpdatedAt: updatedAt,
        expectedFingerprint: launch1000RecordFingerprint(invalidRecord),
      }), operator, snapshot),
      /limited to the approved Launch-1000 Pilot-10/u,
    );
  });
});
