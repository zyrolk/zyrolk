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
import { supplierMappingDocumentId } from "../functions/src/api/suppliers/supplierProductMapping";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRunEmulator = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));

const managedMedia = (identity: string) => [{
  assetId: `${identity}-asset`,
  supplierId: `supplier-${identity}`,
  sourceId: `source-${identity}`,
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
  const otherCategoryId = `home-${suffix}`;
  const otherSubcategoryId = `home-audio-${suffix}`;
  const inactiveCategoryId = `inactive-${suffix}`;
  const inactiveSubcategoryId = `inactive-audio-${suffix}`;
  const mappingId = supplierMappingDocumentId(sourceId, normalizedSupplierCategory);

  const seedQueueItem = async (id: string, offerId = "", pendingRevision = "") => {
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
        supplierCategory,
        supplierSubcategory: "Legacy Buds",
        categoryHierarchy: [supplierCategory, "Legacy Buds"],
        brand: "",
        specifications: { Model: id },
      },
      managedMedia: managedMedia(id),
      mediaFailures: [],
      mediaStatus: "ready",
      mediaReadiness: "ready",
      productValidation: { readyToPublish: true, missingFields: [], errors: [] },
    });
  };

  const seedOfferAndQueue = async (): Promise<{ offerId: string; revision: string }> => {
    const offerId = buildSupplierOfferId(sourceId, `${invalidQueueId}-supplier-product`, `${invalidQueueId}-sku`);
    const timestamp = "2026-09-21T00:00:00.000Z";
    const baseOffer = buildSupplierProductOffer({
      sourceId,
      supplierId,
      supplierProductId: `${invalidQueueId}-supplier-product`,
      sku: `${invalidQueueId}-sku`,
      barcode: `${suffix}1234567890`,
      price: 120,
      cost: 80,
      stock: 4,
      availability: "available",
      lastSyncAt: timestamp,
      catalogPayload: {
        id: `payload-${invalidQueueId}`,
        name: `${invalidQueueId} product`,
        description: "A valid supplier review product description.",
        shortDescription: "A valid supplier review product.",
        price: 120,
        costPrice: 80,
        marketPrice: 120,
        stock: 4,
        category: "",
        subcategory: "",
        brand: "",
        specs: { Model: invalidQueueId },
        imageUrl: `https://supplier.example/${invalidQueueId}.jpg`,
        imageUrls: [`https://supplier.example/${invalidQueueId}.jpg`],
        isActive: false,
      },
      supplierSnapshot: {
        sourceId,
        supplierId,
        supplierProductId: `${invalidQueueId}-supplier-product`,
        sku: `${invalidQueueId}-sku`,
        categoryHierarchy: [supplierCategory, "Legacy Buds"],
        brand: "",
        specifications: { Model: invalidQueueId },
      },
      reviewStatus: "review_pending",
      timestamp,
    });
    const pending = buildSupplierOfferPendingObservation({
      offer: baseOffer,
      kind: "catalog_upsert",
      reviewQueueItemId: invalidQueueId,
      observedAt: timestamp,
      traversalId: `mapping-test-${suffix}`,
    });
    const offer = buildSupplierProductOffer({
      sourceId,
      supplierId,
      supplierProductId: `${invalidQueueId}-supplier-product`,
      sku: `${invalidQueueId}-sku`,
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
    await seedQueueItem(invalidQueueId, offerId, pending.revision);
    const approvalProductId = buildZyroProductId({
      offerId,
      sourceId,
      supplierId,
      supplierProductId: `${invalidQueueId}-supplier-product`,
    });
    await adminDb.collection("supplier_review_queue").doc(invalidQueueId).set({
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
      adminDb.collection("supplier_settings").doc("config").set({ categoryMappings: {}, autoSyncEnabled: false }),
    ]);
    await adminDb.collection("categories").doc(categoryId).set({
      subcategories: [
        { id: subcategoryId, name: "Audio & Earbuds", isActive: true },
        { id: inactiveSubcategoryId, name: "Inactive Audio", isActive: false },
      ],
    }, { merge: true });
    await seedQueueItem(queueId);
    await adminDb.collection("supplier_review_queue").doc(queueId).set({
      approvalBaseline: buildSupplierProductApprovalBaseline(`payload-${queueId}`, undefined, "2026-09-21T00:00:00.000Z"),
    }, { merge: true });

    await t.test("mapping API requires admin authentication and preserves allowlisted responses", async () => {
      assert.equal((await request("GET", "/supplier-category-mappings")).status, 401);
      assert.equal((await request("GET", "/supplier-category-mappings", ordinaryToken)).status, 403);
      const saved = await request("POST", "/supplier-category-mappings", adminToken, {
        sourceId,
        supplierCategory,
        targetCategoryId: categoryId,
        targetSubcategoryId: subcategoryId,
      });
      assert.equal(saved.status, 200);
      const savedBody = await saved.json() as { mapping: Record<string, unknown> };
      assert.equal(savedBody.mapping.sourceId, sourceId);
      assert.equal(savedBody.mapping.supplierCategory, supplierCategory);
      assert.equal(savedBody.mapping.targetCategoryId, categoryId);
      assert.equal(savedBody.mapping.targetSubcategoryId, subcategoryId);
      assert.equal("adminEmail" in savedBody.mapping, false);
      assert.equal("previous" in savedBody.mapping, false);

      const persisted = await adminDb.collection("supplier_category_mappings").doc(mappingId).get();
      assert.equal(persisted.data()?.sourceId, sourceId);
      assert.equal(persisted.data()?.normalizedCategory, normalizedSupplierCategory);
      assert.equal(persisted.data()?.targetCategoryId, categoryId);
      assert.equal(persisted.data()?.targetSubcategoryId, subcategoryId);
      const audits = await adminDb.collection("supplier_mapping_audit").where("mappingId", "==", mappingId).get();
      assert.equal(audits.size, 1);
      assert.equal(audits.docs[0].data().action, "admin_mapping_saved");

      const listed = await request("GET", `/supplier-category-mappings?sourceId=${encodeURIComponent(sourceId)}`, adminToken);
      assert.equal(listed.status, 200);
      const listedBody = await listed.json() as { mappings: Array<Record<string, unknown>> };
      assert.equal(listedBody.mappings.length, 1);
      assert.equal(listedBody.mappings[0].targetSubcategoryId, subcategoryId);
      assert.equal("adminEmail" in listedBody.mappings[0], false);
      assert.equal("current" in listedBody.mappings[0], false);
    });

    await t.test("invalid mappings fail before persistence", async () => {
      const before = (await adminDb.collection("supplier_category_mappings").get()).size;
      const cases: Array<[unknown, number]> = [
        [{ sourceId, supplierCategory: `Inactive ${suffix}`, targetCategoryId: inactiveCategoryId }, 400],
        [{ sourceId, supplierCategory: `Missing ${suffix}`, targetCategoryId: `missing-${suffix}` }, 400],
        [{ sourceId, supplierCategory: `Inactive Sub ${suffix}`, targetCategoryId: categoryId, targetSubcategoryId: inactiveSubcategoryId }, 400],
        [{ sourceId, supplierCategory: `Wrong Parent ${suffix}`, targetCategoryId: categoryId, targetSubcategoryId: otherSubcategoryId }, 400],
        [{ sourceId, supplierCategory: `Missing Sub ${suffix}`, targetCategoryId: categoryId }, 400],
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

    await t.test("existing pending review item receives lazy mapping without queue migration writes", async () => {
      const before = await readQueueData([queueId]);
      const page = await listSupplierQueuePage(adminDb, { view: "review", state: "active", limit: 20 });
      const mapped = page.items.find((item) => item.id === queueId) as Record<string, unknown> | undefined;
      assert.ok(mapped);
      assert.equal((mapped.productPayload as Record<string, unknown>).category, categoryId);
      assert.equal((mapped.productPayload as Record<string, unknown>).subcategory, subcategoryId);
      assert.equal((mapped.categoryMapping as Record<string, unknown>).targetCategoryId, categoryId);
      assert.equal((mapped.categoryMapping as Record<string, unknown>).targetSubcategoryId, subcategoryId);
      const after = await readQueueData([queueId]);
      assert.deepEqual(after, before);
      assert.equal(Object.hasOwn(after[0], "category"), false);
      assert.equal(Object.hasOwn((after[0].productPayload || {}) as Record<string, unknown>, "category"), true);
      assert.equal((after[0].productPayload as Record<string, unknown>).category, "");
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
    });

    await t.test("approval fails closed after the trusted mapping is invalidated", async () => {
      await adminDb.collection("supplier_category_mappings").doc(mappingId).delete();
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
  } finally {
    await deleteApp(adminApp);
    await deleteApp(ordinaryApp);
  }
});
