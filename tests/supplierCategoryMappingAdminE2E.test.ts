import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { adminAuth, adminDb } from "../functions/src/api/firebase";
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  buildSupplierOfferId,
} from "../functions/src/api/suppliers/supplierOfferEngine";
import {
  decideSupplierQueueItem,
  parseSupplierApprovalDraft,
} from "../functions/src/api/suppliers/supplierApproval";
import { buildSupplierProductApprovalBaseline } from "../functions/src/api/suppliers/supplierApprovalConcurrency";
import { buildZyroProductId } from "../functions/src/api/suppliers/supplierProductIdentity";
import { listSupplierQueuePage } from "../functions/src/scheduled/supplierReviewQueue";
import { supplierChildMappingDocumentId, supplierMappingDocumentId } from "../functions/src/api/suppliers/supplierProductMapping";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRunEmulator = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));

const managedMedia = (identity: string, supplierId = `supplier-${identity}`, sourceId = `source-${identity}`) => [{
  assetId: `${identity}-asset`,
  supplierId,
  sourceId,
  productId: `product-${identity}`,
  originalSupplierUrl: `https://supplier.example/${identity}.jpg`,
  originalStoragePath: `supplier-media/${identity}/original.jpg`,
  originalStorageUrl: `https://storage.example/${identity}-original.jpg`,
  firebaseStorageUrl: `https://storage.example/${identity}-managed.webp`,
  contentHash: `${identity}-hash`,
  width: 1200,
  height: 1200,
  mimeType: "image/webp",
  fileSize: 1_000,
  uploadTimestamp: "2026-09-21T00:00:00.000Z",
  imageStatus: "ready",
  isPrimary: true,
  sortOrder: 0,
  variants: {
    large: {
      storagePath: `supplier-media/${identity}/large.webp`,
      storageUrl: `https://storage.example/${identity}-large.webp`,
      width: 1200,
      height: 1200,
      mimeType: "image/webp",
      fileSize: 1_000,
    },
  },
}];

const readQueueData = async (queueIds: string[]): Promise<Record<string, unknown>[]> => {
  const snapshots = await Promise.all(queueIds.map((id) => adminDb.collection("supplier_review_queue").doc(id).get()));
  return snapshots.map((snapshot) => snapshot.data() || {});
};

test("Supplier category mapping API, lazy review projection, and approval authority use emulator persistence", {
  skip: canRunEmulator ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 240_000,
}, async (t) => {
  const suffix = randomUUID().slice(0, 8);
  const sourceId = `mapping-source-${suffix}`;
  const supplierId = `mapping-supplier-${suffix}`;
  const supplierCategory = `Legacy Audio ${suffix}`;
  const normalizedSupplierCategory = supplierCategory.toLocaleLowerCase();
  const queueId = `mapping-review-${suffix}`;
  const invalidQueueId = `mapping-invalid-${suffix}`;
  const adminApp = initializeApp({ apiKey: "demo-key", projectId }, `mapping-admin-${suffix}`);
  const adminClientAuth = getAuth(adminApp);
  connectAuthEmulator(adminClientAuth, `http://${authHost}`, { disableWarnings: true });
  const ordinaryApp = initializeApp({ apiKey: "demo-key", projectId }, `mapping-ordinary-${suffix}`);
  const ordinaryClientAuth = getAuth(ordinaryApp);
  connectAuthEmulator(ordinaryClientAuth, `http://${authHost}`, { disableWarnings: true });

  const apiBase = `http://${functionsHost}/${projectId}/us-central1/api/api`;
  const request = async (method: "GET" | "POST", path: string, token?: string, body?: unknown): Promise<Response> => fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const categoryId = `electronics-${suffix}`;
  const subcategoryId = `audio-earbuds-${suffix}`;
  const secondSubcategoryId = `audio-speakers-${suffix}`;
  const otherCategoryId = `home-${suffix}`;
  const otherSubcategoryId = `home-audio-${suffix}`;
  const inactiveCategoryId = `inactive-${suffix}`;
  const inactiveSubcategoryId = `inactive-audio-${suffix}`;
  const candidateCategoryId = `supplier-taxonomy-health-beauty-${suffix}`;
  const candidateSubcategoryId = `supplier-taxonomy-sub-massage-${suffix}`;
  const candidateSupplierCategory = `Candidate Health ${suffix}`;
  const candidateMappingId = supplierMappingDocumentId(sourceId, candidateSupplierCategory.toLocaleLowerCase());
  const mappingId = supplierMappingDocumentId(sourceId, normalizedSupplierCategory);
  const childMappingId = supplierChildMappingDocumentId(sourceId, normalizedSupplierCategory, "Legacy Buds");
  const childMappingWithId = supplierChildMappingDocumentId(sourceId, normalizedSupplierCategory, "Legacy Buds", "legacy-buds-2");
  const unmapQueueId = `mapping-review-unmap-${suffix}`;
  const unmapSupplierSubcategory = "Legacy Chargers";
  const unmapChildMappingId = supplierChildMappingDocumentId(sourceId, normalizedSupplierCategory, unmapSupplierSubcategory);

  const seedQueueItem = async (id: string, offerId = "", pendingRevision = "", categoryLabel = supplierCategory, subcategoryLabel = "Legacy Buds", subcategoryId = "") => {
    await adminDb.collection("supplier_review_queue").doc(id).set({
      id,
      status: "Pending",
      queueState: "review_pending",
      sourceId,
      supplierId,
      supplierCode: `${id}-sku`,
      supplierOfferId: offerId,
      supplierOfferPendingRevision: pendingRevision,
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      productName: `${id} product`,
      comparisonStatus: "NEW_PRODUCT",
      approvalBaseline: { exists: false },
      productPayload: {
        id: `payload-${id}`,
        name: `${id} product`,
        description: "A valid supplier review product description.",
        shortDescription: "A valid supplier review product.",
        price: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: "",
        subcategory: "",
        brand: "",
        specs: { Model: id },
        imageUrl: `https://supplier.example/${id}.jpg`,
        imageUrls: [`https://supplier.example/${id}.jpg`],
        isActive: false,
      },
      supplierSnapshot: {
        sourceId,
        supplierId,
        supplierProductId: `${id}-supplier-product`,
        sku: `${id}-sku`,
         supplierCategory: categoryLabel,
         ...(subcategoryLabel ? { supplierSubcategory: subcategoryLabel } : {}),
         ...(subcategoryId ? { supplierSubcategoryId: subcategoryId } : {}),
         categoryHierarchy: subcategoryLabel ? [categoryLabel, subcategoryLabel] : [categoryLabel],
        brand: "",
        specifications: { Model: id },
      },
      managedMedia: managedMedia(id, supplierId, sourceId),
      mediaFailures: [],
      mediaStatus: "ready",
      mediaReadiness: "ready",
      productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    });
  };

  const seedOfferAndQueue = async (id = invalidQueueId, categoryLabel = supplierCategory, subcategoryLabel = "Legacy Buds"): Promise<{ offerId: string; revision: string }> => {
    const offerId = buildSupplierOfferId(sourceId, `${id}-supplier-product`, `${id}-sku`);
    const timestamp = "2026-09-21T00:00:00.000Z";
    const baseOffer = buildSupplierProductOffer({
      sourceId,
      supplierId,
       supplierProductId: `${id}-supplier-product`,
       sku: `${id}-sku`,
      barcode: `${suffix}1234567890`,
      price: 120,
      cost: 80,
      stock: 4,
      availability: "available",
      lastSyncAt: timestamp,
      catalogPayload: {
         id: `payload-${id}`,
         name: `${id} product`,
        description: "A valid supplier review product description.",
        shortDescription: "A valid supplier review product.",
        price: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: "",
        subcategory: "",
        brand: "",
         specs: { Model: id },
         imageUrl: `https://supplier.example/${id}.jpg`,
         imageUrls: [`https://supplier.example/${id}.jpg`],
        isActive: false,
      },
      supplierSnapshot: {
        sourceId,
        supplierId,
         supplierProductId: `${id}-supplier-product`,
         sku: `${id}-sku`,
         categoryHierarchy: subcategoryLabel ? [categoryLabel, subcategoryLabel] : [categoryLabel],
        brand: "",
         specifications: { Model: id },
      },
      reviewStatus: "review_pending",
      timestamp,
    });
    const pending = buildSupplierOfferPendingObservation({
      offer: baseOffer,
      kind: "catalog_upsert",
       reviewQueueItemId: id,
      observedAt: timestamp,
      traversalId: `mapping-test-${suffix}`,
    });
    const offer = buildSupplierProductOffer({
      sourceId,
      supplierId,
       supplierProductId: `${id}-supplier-product`,
       sku: `${id}-sku`,
      barcode: `${suffix}1234567890`,
      productId: "",
      price: 120,
      cost: 80,
      stock: 4,
      availability: "available",
      lastSyncAt: timestamp,
      catalogPayload: baseOffer.catalogPayload,
      supplierSnapshot: baseOffer.supplierSnapshot,
      reviewStatus: "review_pending",
      pendingObservation: pending,
      timestamp,
    });
    assert.equal(offer.id, offerId);
    await adminDb.collection("supplier_product_offers").doc(offerId).set(offer);
    await seedQueueItem(id, offerId, pending.revision, categoryLabel, subcategoryLabel);
    const approvalProductId = buildZyroProductId({
      offerId,
      sourceId,
      supplierId,
       supplierProductId: `${id}-supplier-product`,
    });
    await adminDb.collection("supplier_review_queue").doc(id).set({
      approvalBaseline: buildSupplierProductApprovalBaseline(approvalProductId, undefined, timestamp),
    }, { merge: true });
    return { offerId, revision: pending.revision };
  };

  try {
    const credential = await createUserWithEmailAndPassword(
      adminClientAuth,
      `mapping-admin-${suffix}@example.test`,
      `Zyro-${randomUUID()}!`,
    );
    const ordinaryCredential = await createUserWithEmailAndPassword(
      ordinaryClientAuth,
      `mapping-ordinary-${suffix}@example.test`,
      `Zyro-${randomUUID()}!`,
    );
    await adminAuth.setCustomUserClaims(credential.user.uid, { supplierHubAdmin: true });
    const adminToken = await credential.user.getIdToken(true);
    const ordinaryToken = await ordinaryCredential.user.getIdToken();

    await Promise.all([
      adminDb.collection("supplierSources").doc(sourceId).set({
        supplierId,
        supplierName: `Mapping Supplier ${suffix}`,
        sourceStatus: "active",
        enabled: true,
      }),
      adminDb.collection("categories").doc(categoryId).set({
        name: "Electronics",
        isActive: true,
        subcategories: [{ id: subcategoryId, name: "Audio & Earbuds", isActive: true }],
        specificationTemplate: [],
      }),
      adminDb.collection("categories").doc(otherCategoryId).set({
        name: "Home",
        isActive: true,
        subcategories: [{ id: otherSubcategoryId, name: "Home Audio", isActive: true }],
        specificationTemplate: [],
      }),
      adminDb.collection("categories").doc(inactiveCategoryId).set({
        name: "Inactive",
        isActive: false,
        subcategories: [],
      }),
      adminDb.collection("categories").doc(candidateCategoryId).set({
        name: "Candidate Health",
        isActive: true,
        taxonomyCandidate: true,
        taxonomyStatus: "active",
        subcategories: [{ id: candidateSubcategoryId, name: "Massage", isActive: true, taxonomyCandidate: true }],
      }),
      adminDb.collection("supplier_settings").doc("config").set({ categoryMappings: {}, autoSyncEnabled: false }),
    ]);
    await adminDb.collection("categories").doc(categoryId).set({
      subcategories: [
        { id: subcategoryId, name: "Audio & Earbuds", isActive: true },
        { id: secondSubcategoryId, name: "Audio Speakers", isActive: true },
        { id: inactiveSubcategoryId, name: "Inactive Audio", isActive: false },
      ],
    }, { merge: true });
    await seedQueueItem(queueId);
    await seedQueueItem(unmapQueueId, "", "", supplierCategory, unmapSupplierSubcategory);
    await adminDb.collection("supplier_review_queue").doc(queueId).set({
      approvalBaseline: buildSupplierProductApprovalBaseline(`payload-${queueId}`, undefined, "2026-09-21T00:00:00.000Z"),
    }, { merge: true });

    await t.test("mapping API requires admin authentication and preserves allowlisted responses", async () => {
      assert.equal((await request("GET", "/supplier-category-mappings")).status, 401);
      assert.equal((await request("GET", "/supplier-category-mappings", ordinaryToken)).status, 403);
      const saved = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory,
        supplierSubcategory: "Legacy Buds",
        targetCategoryId: categoryId,
        targetSubcategoryId: subcategoryId,
      });
      assert.equal(saved.status, 200);
      const savedBody = await saved.json() as { mapping: Record<string, unknown> };
      assert.equal(savedBody.mapping.sourceId, sourceId);
      assert.equal(savedBody.mapping.supplierCategory, supplierCategory);
      assert.equal(savedBody.mapping.supplierSubcategory, "Legacy Buds");
      assert.equal(savedBody.mapping.normalizedSupplierSubcategory, "legacy buds");
      assert.equal(savedBody.mapping.targetCategoryId, categoryId);
      assert.equal(savedBody.mapping.targetSubcategoryId, subcategoryId);
      assert.equal(savedBody.mapping.mappingScope, "child");
      assert.equal("adminEmail" in savedBody.mapping, false);
      assert.equal("previous" in savedBody.mapping, false);

      const persistedParent = await adminDb.collection("supplier_category_mappings").doc(mappingId).get();
      assert.equal(persistedParent.data()?.sourceId, sourceId);
      assert.equal(persistedParent.data()?.normalizedCategory, normalizedSupplierCategory);
      assert.equal(persistedParent.data()?.targetCategoryId, categoryId);
      assert.equal(persistedParent.data()?.targetSubcategoryId, "");
      assert.equal(persistedParent.data()?.mappingScope, "parent");
      const persisted = await adminDb.collection("supplier_category_mappings").doc(childMappingId).get();
      assert.equal(persisted.data()?.sourceId, sourceId);
      assert.equal(persisted.data()?.targetCategoryId, categoryId);
      assert.equal(persisted.data()?.targetSubcategoryId, subcategoryId);
      assert.equal(persisted.data()?.mappingScope, "child");
      const audits = await adminDb.collection("supplier_mapping_audit").where("mappingId", "==", childMappingId).get();
      assert.equal(audits.size, 1);
      assert.equal(audits.docs[0].data().action, "admin_mapping_saved");

      const secondChild = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory,
        supplierSubcategory: "Legacy Buds",
        supplierSubcategoryId: "legacy-buds-2",
        targetCategoryId: categoryId,
        targetSubcategoryId: secondSubcategoryId,
      });
      assert.equal(secondChild.status, 200);
      const secondChildBody = await secondChild.json() as { mapping: Record<string, unknown> };
      assert.equal(secondChildBody.mapping.targetSubcategoryId, secondSubcategoryId);
      assert.equal(secondChildBody.mapping.supplierSubcategoryId, "legacy-buds-2");
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingWithId).get()).data()?.targetSubcategoryId, secondSubcategoryId);

      const listed = await request("GET", `/supplier-category-mappings?sourceId=${encodeURIComponent(sourceId)}`, adminToken);
      assert.equal(listed.status, 200);
      const listedBody = await listed.json() as { mappings: Array<Record<string, unknown>> };
      assert.equal(listedBody.mappings.length, 3);
      const listedChild = listedBody.mappings.find((mapping) => mapping.id === childMappingId)!;
      const listedSecondChild = listedBody.mappings.find((mapping) => mapping.id === childMappingWithId)!;
      assert.equal(listedChild.supplierSubcategory, "Legacy Buds");
      assert.equal(listedChild.targetSubcategoryId, subcategoryId);
      assert.equal(listedSecondChild.targetSubcategoryId, secondSubcategoryId);
      assert.equal("adminEmail" in listedChild, false);
      assert.equal("current" in listedChild, false);
    });

    await t.test("exact child unmap is admin-only, audited, and falls back without touching queue or products", async () => {
      const beforeQueue = (await adminDb.collection("supplier_review_queue").doc(unmapQueueId).get()).data();
      const beforeProducts = (await adminDb.collection("products").get()).docs.map((document) => ({ id: document.id, data: document.data() }));
      const saved = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory,
        supplierSubcategory: unmapSupplierSubcategory,
        targetCategoryId: categoryId,
        targetSubcategoryId: secondSubcategoryId,
      });
      assert.equal(saved.status, 200);
      const mappedPage = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 40 });
      const mappedItem = mappedPage.items.find((item) => item.id === unmapQueueId) as Record<string, unknown> | undefined;
      assert.equal((mappedItem?.productPayload as Record<string, unknown>)?.category, categoryId);
      assert.equal((mappedItem?.productPayload as Record<string, unknown>)?.subcategory, secondSubcategoryId);

      const removalBody = {
        mappingId: unmapChildMappingId,
        sourceId,
        supplierCategory,
        supplierSubcategory: unmapSupplierSubcategory,
      };
      assert.equal((await request("POST", "/supplier-category-mappings/unmap", undefined, removalBody)).status, 401);
      assert.equal((await request("POST", "/supplier-category-mappings/unmap", ordinaryToken, removalBody)).status, 403);
      assert.equal((await request("POST", "/supplier-category-mappings/unmap", adminToken, {
        ...removalBody,
        sourceId: `other-source-${suffix}`,
      })).status, 400);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(unmapChildMappingId).get()).exists, true);

      const missingMappingId = supplierChildMappingDocumentId(sourceId, normalizedSupplierCategory, "Missing Child");
      const missing = await request("POST", "/supplier-category-mappings/unmap", adminToken, {
        mappingId: missingMappingId,
        sourceId,
        supplierCategory,
        supplierSubcategory: "Missing Child",
      });
      assert.equal(missing.status, 200);
      assert.equal((await missing.json() as { result?: { removed?: boolean } }).result?.removed, false);

      const removed = await request("POST", "/supplier-category-mappings/unmap", adminToken, removalBody);
      assert.equal(removed.status, 200);
      const removedBody = await removed.json() as { success?: boolean; result?: { id?: string; removed?: boolean } };
      assert.equal(removedBody.success, true);
      assert.equal(removedBody.result?.id, unmapChildMappingId);
      assert.equal(removedBody.result?.removed, true);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(unmapChildMappingId).get()).exists, false);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(mappingId).get()).data()?.targetCategoryId, categoryId);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(mappingId).get()).data()?.targetSubcategoryId, "");
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingId).get()).data()?.targetSubcategoryId, subcategoryId);
      const removalAudits = await adminDb.collection("supplier_mapping_audit").where("mappingId", "==", unmapChildMappingId).get();
      assert.equal(removalAudits.docs.at(-1)?.data().action, "admin_mapping_removed");

      const readBack = await request("GET", `/supplier-category-mappings?sourceId=${encodeURIComponent(sourceId)}`, adminToken);
      const readBackBody = await readBack.json() as { mappings: Array<Record<string, unknown>> };
      assert.equal(readBackBody.mappings.some((mapping) => mapping.id === unmapChildMappingId), false);
      const fallbackPage = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 40 });
      const fallbackItem = fallbackPage.items.find((item) => item.id === unmapQueueId) as Record<string, unknown> | undefined;
      assert.equal((fallbackItem?.productPayload as Record<string, unknown>)?.category, categoryId);
      assert.equal((fallbackItem?.productPayload as Record<string, unknown>)?.subcategory, "");
      assert.deepEqual((await adminDb.collection("supplier_review_queue").doc(unmapQueueId).get()).data(), beforeQueue);
      assert.deepEqual((await adminDb.collection("products").get()).docs.map((document) => ({ id: document.id, data: document.data() })), beforeProducts);
    });

    await t.test("invalid mappings fail before persistence", async () => {
      const before = (await adminDb.collection("supplier_category_mappings").get()).size;
      const cases: Array<[unknown, number]> = [
        [{ sourceId, supplierCategory: `Inactive ${suffix}`, targetCategoryId: inactiveCategoryId }, 400],
        [{ sourceId, supplierCategory: `Missing ${suffix}`, targetCategoryId: `missing-${suffix}` }, 400],
        [{ sourceId, supplierCategory: `Inactive Sub ${suffix}`, targetCategoryId: categoryId, targetSubcategoryId: inactiveSubcategoryId }, 400],
        [{ sourceId, supplierCategory: `Wrong Parent ${suffix}`, targetCategoryId: categoryId, targetSubcategoryId: otherSubcategoryId }, 400],
        [{ sourceId, supplierCategory: `Missing Sub ${suffix}`, supplierSubcategory: "Legacy Buds", targetCategoryId: categoryId }, 400],
        [{ sourceId, supplierCategory: candidateSupplierCategory, targetCategoryId: candidateCategoryId }, 400],
        [{ sourceId: `missing-source-${suffix}`, supplierCategory: "Any", targetCategoryId: categoryId, targetSubcategoryId: subcategoryId }, 404],
        [{ sourceId: [sourceId], supplierCategory: "Array", targetCategoryId: categoryId, targetSubcategoryId: subcategoryId }, 400],
        [{ sourceId, supplierCategory: ["Array"], targetCategoryId: categoryId, targetSubcategoryId: subcategoryId }, 400],
      ];
      for (const [body, expectedStatus] of cases) {
        const response = await request("POST", "/supplier-category-mappings", adminToken, body);
        assert.equal(response.status, expectedStatus);
      }
      assert.equal((await adminDb.collection("supplier_category_mappings").get()).size, before);
    });

    await t.test("category-only mapping is accepted for a category with active subcategories", async () => {
      const categoryOnlyCategory = `Category Only ${suffix}`;
      const response = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory: categoryOnlyCategory,
        targetCategoryId: categoryId,
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { mapping: Record<string, unknown> };
      assert.equal(body.mapping.targetCategoryId, categoryId);
      assert.equal(body.mapping.targetSubcategoryId, "");
      assert.equal(body.mapping.mappingScope, "parent");
      assert.equal("supplierSubcategory" in body.mapping, false);
      const categoryOnlyId = supplierMappingDocumentId(sourceId, categoryOnlyCategory.toLocaleLowerCase());
      const persisted = await adminDb.collection("supplier_category_mappings").doc(categoryOnlyId).get();
      assert.equal(persisted.data()?.targetCategoryId, categoryId);
      assert.equal(persisted.data()?.targetSubcategoryId, "");
      const categoryOnlyQueueId = `mapping-parent-only-${suffix}`;
      await seedQueueItem(categoryOnlyQueueId, "", "", categoryOnlyCategory, "");
      const categoryOnlyPage = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 40 });
      const categoryOnlyReview = categoryOnlyPage.items.find((item) => item.id === categoryOnlyQueueId) as Record<string, unknown> | undefined;
      assert.ok(categoryOnlyReview);
      assert.equal((categoryOnlyReview.productPayload as Record<string, unknown>).category, categoryId);
      assert.equal((categoryOnlyReview.productPayload as Record<string, unknown>).subcategory, "");
      assert.equal((categoryOnlyReview.categoryMapping as Record<string, unknown>).requiresManualSelection, true);
    });

    await t.test("existing pending review item receives lazy mapping without queue migration writes", async () => {
      const before = await readQueueData([queueId]);
      const secondQueueId = `mapping-review-child-id-${suffix}`;
      const staleQueueId = `mapping-review-stale-taxonomy-${suffix}`;
      await seedQueueItem(secondQueueId, "", "", supplierCategory, "Legacy Buds", "legacy-buds-2");
      await seedQueueItem(staleQueueId, "", "", supplierCategory, "");
      await adminDb.collection("supplier_review_queue").doc(staleQueueId).set({
        productPayload: { category: categoryId, subcategory: subcategoryId },
      }, { merge: true });
      const page = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 20 });
      const mapped = page.items.find((item) => item.id === queueId) as Record<string, unknown> | undefined;
      const mappedSecond = page.items.find((item) => item.id === secondQueueId) as Record<string, unknown> | undefined;
      const mappedStale = page.items.find((item) => item.id === staleQueueId) as Record<string, unknown> | undefined;
      assert.ok(mapped);
      assert.ok(mappedSecond);
      assert.ok(mappedStale);
      assert.equal((mapped.productPayload as Record<string, unknown>).category, categoryId);
      assert.equal((mapped.productPayload as Record<string, unknown>).subcategory, subcategoryId);
      assert.equal((mapped.categoryMapping as Record<string, unknown>).targetCategoryId, categoryId);
      assert.equal((mapped.categoryMapping as Record<string, unknown>).targetSubcategoryId, subcategoryId);
      assert.equal((mappedSecond.productPayload as Record<string, unknown>).subcategory, secondSubcategoryId);
      assert.equal((mappedSecond.categoryMapping as Record<string, unknown>).targetSubcategoryId, secondSubcategoryId);
      assert.equal((mappedStale.productPayload as Record<string, unknown>).category, categoryId);
      assert.equal((mappedStale.productPayload as Record<string, unknown>).subcategory, "");
      const after = await readQueueData([queueId]);
      assert.deepEqual(after, before);
      assert.equal(Object.hasOwn(after[0], "category"), false);
      assert.equal(Object.hasOwn((after[0].productPayload || {}) as Record<string, unknown>, "category"), true);
      assert.equal((after[0].productPayload as Record<string, unknown>).category, "");
    });

    await t.test("active supplier-taxonomy candidate mappings remain unresolved", async () => {
      await adminDb.collection("supplier_category_mappings").doc(candidateMappingId).set({
        sourceId,
        supplierCategory: candidateSupplierCategory,
        normalizedCategory: candidateSupplierCategory.toLocaleLowerCase(),
        mappingScope: "parent",
        targetCategoryId: candidateCategoryId,
        targetSubcategoryId: candidateSubcategoryId,
        confidence: 100,
        mappingType: "learned",
        version: 1,
        updatedBy: "test",
      });
      const candidateQueueId = `mapping-candidate-review-${suffix}`;
      await seedQueueItem(candidateQueueId, "", "", candidateSupplierCategory, "Massage");
      const page = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 80 });
      const candidate = page.items.find((item) => item.id === candidateQueueId) as Record<string, unknown> | undefined;
      assert.ok(candidate);
      assert.equal((candidate.productPayload as Record<string, unknown>).category, "");
      assert.equal((candidate.productPayload as Record<string, unknown>).subcategory, "");
      assert.equal((candidate.categoryMapping as Record<string, unknown> | undefined)?.targetCategoryId, undefined);
    });

    const { offerId, revision } = await seedOfferAndQueue();
    await t.test("approval re-resolves trusted mapping and permits absent supplier brand", async () => {
      const draft = parseSupplierApprovalDraft({
        productName: `${invalidQueueId} approved`,
        description: "A valid supplier review product description.",
        sellingPrice: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: "malicious-category",
        subcategory: "malicious-subcategory",
        brand: "",
        specifications: { Model: invalidQueueId },
        isActive: false,
        primaryImageUrl: `https://storage.example/${invalidQueueId}-managed.webp`,
        galleryImageUrls: [],
      });
      assert.ok(draft);
      const result = await decideSupplierQueueItem(adminDb, invalidQueueId, "approved", {
        uid: `mapping-admin-${suffix}`,
        email: `mapping-admin-${suffix}@example.test`,
      }, { draft, expectedPendingRevision: revision });
      assert.equal(result.success, true);
      const product = (await adminDb.collection("products").doc(result.productId!).get()).data()!;
      assert.equal(product.category, categoryId);
      assert.equal(product.subcategory, subcategoryId);
      assert.equal(Object.hasOwn(product, "brand"), false);
      assert.equal((await adminDb.collection("supplier_product_offers").doc(offerId).get()).data()?.reviewStatus, "approved");
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingWithId).get()).data()?.targetSubcategoryId, secondSubcategoryId);
    });

    await t.test("approval learns category without poisoning it with a product-only subcategory", async () => {
      const noSubcategoryQueueId = `mapping-no-subcategory-${suffix}`;
      const supplierOnlyCategory = `Category Only Approval ${suffix}`;
      const seeded = await seedOfferAndQueue(noSubcategoryQueueId, supplierOnlyCategory, "");
      const draft = parseSupplierApprovalDraft({
        productName: `${noSubcategoryQueueId} approved`,
        description: "A valid supplier review product description.",
        sellingPrice: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: categoryId,
        subcategory: subcategoryId,
        brand: "",
        specifications: { Model: noSubcategoryQueueId },
        isActive: false,
        primaryImageUrl: `https://storage.example/${noSubcategoryQueueId}-managed.webp`,
        galleryImageUrls: [],
        fieldOwnership: { category: "admin", subcategory: "admin" },
        editedFields: ["category", "subcategory"],
      });
      assert.ok(draft);
      const result = await decideSupplierQueueItem(adminDb, noSubcategoryQueueId, "approved", {
        uid: `mapping-admin-${suffix}`,
        email: `mapping-admin-${suffix}@example.test`,
      }, { draft, expectedPendingRevision: seeded.revision });
      assert.equal(result.success, true);
      const product = (await adminDb.collection("products").doc(result.productId!).get()).data()!;
      assert.equal(product.category, categoryId);
      assert.equal(product.subcategory, subcategoryId);
      const mapping = (await adminDb.collection("supplier_category_mappings")
        .doc(supplierMappingDocumentId(sourceId, supplierOnlyCategory.toLocaleLowerCase())).get()).data()!;
      assert.equal(mapping.targetCategoryId, categoryId);
      assert.equal(mapping.targetSubcategoryId, "");
      assert.equal(Object.hasOwn(mapping, "supplierSubcategory"), false);
      assert.equal(Object.hasOwn(mapping, "normalizedSupplierSubcategory"), false);
    });

    await t.test("valid explicit taxonomy draft survives parent mapping retarget", async () => {
      const explicitQueueId = `mapping-explicit-taxonomy-${suffix}`;
      const seeded = await seedOfferAndQueue(explicitQueueId, supplierCategory, "");
      const draft = parseSupplierApprovalDraft({
        productName: `${explicitQueueId} approved`,
        description: "A valid supplier review product description.",
        sellingPrice: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: otherCategoryId,
        subcategory: otherSubcategoryId,
        brand: "",
        specifications: { Model: explicitQueueId },
        isActive: false,
        primaryImageUrl: `https://storage.example/${explicitQueueId}-managed.webp`,
        galleryImageUrls: [],
        fieldOwnership: { category: "admin", subcategory: "admin" },
        editedFields: ["category", "subcategory"],
      });
      assert.ok(draft);
      const result = await decideSupplierQueueItem(adminDb, explicitQueueId, "approved", {
        uid: `mapping-admin-${suffix}`,
        email: `mapping-admin-${suffix}@example.test`,
      }, { draft, expectedPendingRevision: seeded.revision });
      assert.equal(result.success, true);
      const product = (await adminDb.collection("products").doc(result.productId!).get()).data()!;
      assert.equal(product.category, otherCategoryId);
      assert.equal(product.subcategory, otherSubcategoryId);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(mappingId).get()).data()?.targetCategoryId, otherCategoryId);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingId).get()).data()?.targetSubcategoryId, subcategoryId);
    });

    await t.test("legacy stale supplier-derived subcategory fails closed at approval", async () => {
      const staleQueueId = `mapping-stale-approval-${suffix}`;
      const seeded = await seedOfferAndQueue(staleQueueId, supplierCategory, "");
      await adminDb.collection("supplier_review_queue").doc(staleQueueId).set({
        productPayload: { category: otherCategoryId, subcategory: otherSubcategoryId },
      }, { merge: true });
      const staleDraft = parseSupplierApprovalDraft({
        productName: `${staleQueueId} stale draft`,
        description: "A valid supplier review product description.",
        sellingPrice: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: otherCategoryId,
        subcategory: otherSubcategoryId,
        brand: "",
        specifications: { Model: staleQueueId },
        isActive: false,
        primaryImageUrl: `https://storage.example/${staleQueueId}-managed.webp`,
        galleryImageUrls: [],
        fieldOwnership: { category: "admin", subcategory: "admin" },
        editedFields: [],
      });
      assert.ok(staleDraft);
      await assert.rejects(
        () => decideSupplierQueueItem(adminDb, staleQueueId, "approved", {
          uid: `mapping-admin-${suffix}`,
          email: `mapping-admin-${suffix}@example.test`,
        }, { draft: staleDraft, expectedPendingRevision: seeded.revision }),
        /subcategory|validation/i,
      );
      assert.equal((await adminDb.collection("supplier_review_queue").doc(staleQueueId).get()).data()?.queueState, "review_pending");
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingId).get()).data()?.targetSubcategoryId, subcategoryId);
    });

    await t.test("parent retarget fences stale children and remaps only the selected child", async () => {
      const secondQueueId = `mapping-review-child-id-${suffix}`;
      const retarget = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory,
        targetCategoryId: otherCategoryId,
      });
      assert.equal(retarget.status, 200);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(mappingId).get()).data()?.targetCategoryId, otherCategoryId);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingId).get()).data()?.targetCategoryId, categoryId);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingWithId).get()).data()?.targetCategoryId, categoryId);

      const fencedPage = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 40 });
      const fencedFirst = fencedPage.items.find((item) => item.id === queueId) as Record<string, unknown> | undefined;
      const fencedSecond = fencedPage.items.find((item) => item.id === secondQueueId) as Record<string, unknown> | undefined;
      assert.equal((fencedFirst?.productPayload as Record<string, unknown>)?.category, otherCategoryId);
      assert.equal((fencedFirst?.productPayload as Record<string, unknown>)?.subcategory, "");
      assert.equal((fencedSecond?.productPayload as Record<string, unknown>)?.category, otherCategoryId);
      assert.equal((fencedSecond?.productPayload as Record<string, unknown>)?.subcategory, "");

      const remap = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory,
        supplierSubcategory: "Legacy Buds",
        targetCategoryId: otherCategoryId,
        targetSubcategoryId: otherSubcategoryId,
      });
      assert.equal(remap.status, 200);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingId).get()).data()?.mappingScope, "child");
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingId).get()).data()?.targetCategoryId, otherCategoryId);
      assert.equal((await adminDb.collection("supplier_category_mappings").doc(childMappingWithId).get()).data()?.targetCategoryId, categoryId);

      const remappedPage = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 40 });
      const remappedFirst = remappedPage.items.find((item) => item.id === queueId) as Record<string, unknown> | undefined;
      const remappedSecond = remappedPage.items.find((item) => item.id === secondQueueId) as Record<string, unknown> | undefined;
      assert.equal((remappedFirst?.productPayload as Record<string, unknown>)?.category, otherCategoryId);
      assert.equal((remappedFirst?.productPayload as Record<string, unknown>)?.subcategory, otherSubcategoryId);
      assert.equal((remappedSecond?.productPayload as Record<string, unknown>)?.category, otherCategoryId);
      assert.equal((remappedSecond?.productPayload as Record<string, unknown>)?.subcategory, "");
    });

    await t.test("approval fails closed after the trusted mapping is invalidated", async () => {
      await adminDb.collection("supplier_category_mappings").doc(mappingId).delete();
      await adminDb.collection("supplier_category_mappings").doc(childMappingId).delete();
      const draft = parseSupplierApprovalDraft({
        productName: `${queueId} approval`,
        description: "A valid supplier review product description.",
        sellingPrice: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: "",
        subcategory: "",
        brand: "",
        specifications: { Model: queueId },
        isActive: false,
        primaryImageUrl: `https://storage.example/${queueId}-managed.webp`,
        galleryImageUrls: [],
      });
      await assert.rejects(
        () => decideSupplierQueueItem(adminDb, queueId, "approved", {
          uid: `mapping-admin-${suffix}`,
          email: `mapping-admin-${suffix}@example.test`,
        }, { draft }),
        /validation failed|category/i,
      );
      assert.equal((await adminDb.collection("supplier_review_queue").doc(queueId).get()).data()?.queueState, "review_pending");
      assert.equal((await adminDb.collection("products").where("name", "==", `${queueId} approval`).get()).empty, true);
    });

    await t.test("approval rejects an active supplier-taxonomy candidate without writing a product", async () => {
      const candidateQueueId = `mapping-candidate-approval-${suffix}`;
      const seeded = await seedOfferAndQueue(candidateQueueId, candidateSupplierCategory, "");
      await adminDb.collection("supplier_category_mappings").doc(candidateMappingId).set({
        sourceId,
        supplierCategory: candidateSupplierCategory,
        normalizedCategory: candidateSupplierCategory.toLocaleLowerCase(),
        mappingScope: "parent",
        targetCategoryId: candidateCategoryId,
        targetSubcategoryId: "",
        confidence: 100,
        mappingType: "learned",
        version: 2,
        updatedBy: "test",
      });
      const draft = parseSupplierApprovalDraft({
        productName: `${candidateQueueId} blocked`,
        description: "A valid supplier review product description.",
        sellingPrice: 120,
        costPrice: 80,
        stock: 4,
        category: candidateCategoryId,
        subcategory: "",
        brand: "",
        specifications: { Model: candidateQueueId },
        isActive: false,
        primaryImageUrl: `https://storage.example/${candidateQueueId}-managed.webp`,
        galleryImageUrls: [],
      });
      assert.ok(draft);
      await assert.rejects(
        () => decideSupplierQueueItem(adminDb, candidateQueueId, "approved", {
          uid: `mapping-admin-${suffix}`,
          email: `mapping-admin-${suffix}@example.test`,
        }, { draft, expectedPendingRevision: seeded.revision }),
        /active canonical Zyro category|validation failed/i,
      );
      assert.equal((await adminDb.collection("supplier_review_queue").doc(candidateQueueId).get()).data()?.queueState, "review_pending");
      assert.equal((await adminDb.collection("supplier_product_offers").doc(seeded.offerId).get()).data()?.reviewStatus, "review_pending");
      assert.equal((await adminDb.collection("products").where("name", "==", `${candidateQueueId} blocked`).get()).empty, true);
    });
  } finally {
    await deleteApp(adminApp);
    await deleteApp(ordinaryApp);
  }
});
