import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { deleteApp, initializeApp } from "firebase/app";
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signOut } from "firebase/auth";
import { collection, doc, getDoc, getDocs, query, setDoc, where } from "firebase/firestore";
import { adminAuth, adminDb, FieldValue } from "../functions/src/api/firebase";
import { createAdminProduct } from "../functions/src/api/products/adminProductManagement";
import { hashValue } from "../functions/src/api/checkout/checkoutLogic";
import { createSupplierReviewDraft } from "../src/services/supplierReviewEditor";
import { decideSupplierQueueItem, parseSupplierApprovalDraft } from "../functions/src/api/suppliers/supplierApproval";
import { buildSupplierProductOffer } from "../functions/src/api/suppliers/supplierOfferEngine";
import type { SupplierOutboundResponse } from "../functions/src/api/security/supplierOutboundRequest";
import type {
  SupplierManagedMediaAsset,
  SupplierMediaPipelineDependencies,
} from "../functions/src/api/suppliers/supplierMediaPipeline";
import { processSupplierReviewQueueItem } from "../functions/src/scheduled/supplierReviewQueue";
import {
  assertReviewOwnershipMigrationAuthorized,
  MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_BATCH,
  migrateReviewOwnershipData,
  REVIEW_DOCUMENTS_PER_BATCH,
  ReviewOwnershipMigrationConflictError,
} from "../scripts/migrateReviewOwnershipData";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRun = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));
const prefix = "p1-production-blockers";

const portalMediaBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);
// Distinct valid PNG bytes (different pixels) so content-addressed hashing must diverge.
const changedPortalMediaBody = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRmAKABf2A/38FIMyAAAAAElFTkSuQmCC",
  "base64",
);

const portalMediaResponse = (body = portalMediaBody): SupplierOutboundResponse => ({
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": "image/png", "content-length": String(body.length) }),
  text: async () => body.toString("utf8"),
  arrayBuffer: async () => body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer,
  json: async <T>() => JSON.parse(body.toString("utf8")) as T,
});

const portalMediaDependencies = (): SupplierMediaPipelineDependencies => ({
  fetchImage: async (url) => portalMediaResponse(url.includes("changed-product-image") ? changedPortalMediaBody : portalMediaBody),
  findAsset: async (contentHash) => {
    const snapshot = await adminDb.collection("supplier_media_assets").doc(contentHash).get();
    return snapshot.exists ? snapshot.data() as SupplierManagedMediaAsset : null;
  },
  saveFile: async (storagePath) => `https://firebasestorage.googleapis.com/v0/b/${projectId}.appspot.com/o/${encodeURIComponent(storagePath)}?alt=media`,
  saveAsset: async (asset) => { await adminDb.collection("supplier_media_assets").doc(asset.assetId).set(asset); },
  recordAudit: async (event) => { await adminDb.collection("supplier_media_audit").add(event); },
});

test("P1 production blockers fail closed at trusted and Rules boundaries", {
  skip: canRun ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 180_000,
}, async (t) => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(authHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);

  await t.test("price increases and decreases require explicit reconfirmation with zero partial writes", async () => {
    for (const [scenario, displayedPrice, currentPrice, phone, network] of [
      ["increase", 1_400, 1_500, "0771112233", "203.0.113.51"],
      ["decrease", 1_600, 1_500, "0771112244", "203.0.113.52"],
    ] as const) {
      const productId = `${prefix}-price-${scenario}`;
      const idempotencyKey = `${prefix}-price-${scenario}-key-0001`;
      await Promise.all([
        adminDb.collection("products").doc(productId).set({ id: productId, name: `Price fence ${scenario}`, price: currentPrice, stock: 4, isActive: true }),
        adminDb.collection("product_private").doc(productId).set({ productId, sku: `ZY-P1-PRICE-${scenario.toUpperCase()}`, fulfilmentMode: "internal" }),
      ]);
      const body: Record<string, unknown> & { cartItems: Array<{ productId: string; quantity: number; expectedUnitPrice: number }> } = {
        customerUid: "guest",
        customerName: "Price Customer",
        customerPhone: phone,
        customerEmail: "price@example.test",
        customerAddress: "1 Price Road",
        district: "Colombo",
        city: "Colombo",
        paymentMethod: "cod",
        cartItems: [{ productId, quantity: 1, expectedUnitPrice: displayedPrice }],
      };
      const request = (payload = body) => fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Forwarded-For": network },
        body: JSON.stringify(payload),
      });
      const response = await request();
      const responseBody = await response.json() as { code?: string; priceChanges?: unknown[] };
      assert.equal(response.status, 409);
      assert.equal(responseBody.code, "CHECKOUT_PRICE_CHANGED");
      assert.equal(responseBody.priceChanges?.length, 1);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.stock, 4);
      assert.equal((await adminDb.collection("orders").where("customerPhone", "==", phone).get()).size, 0);
      assert.equal((await adminDb.collection("checkout_idempotency").doc(hashValue(idempotencyKey)).get()).exists, false);

      const confirmed = await request({ ...body, cartItems: [{ productId, quantity: 1, expectedUnitPrice: currentPrice }] });
      const confirmedBody = await confirmed.json() as { order?: { id?: string }; error?: string };
      assert.equal(confirmed.status, 200, confirmedBody.error);
      const exactRetry = await request({ ...body, cartItems: [{ productId, quantity: 1, expectedUnitPrice: currentPrice }] });
      assert.equal(exactRetry.status, 200);
      assert.equal((await exactRetry.json() as { order?: { id?: string } }).order?.id, confirmedBody.order?.id);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.stock, 3);
    }
  });

  await t.test("manual creation is explicitly internal and rejects arbitrary supplier routing", async () => {
    const categoryId = `${prefix}-category`;
    const brandId = `${prefix}-brand`;
    await Promise.all([
      adminDb.collection("categories").doc(categoryId).set({ name: "P1 Category", isActive: true, subcategories: [] }),
      adminDb.collection("brands").doc(brandId).set({ name: "P1 Brand", isActive: true }),
    ]);
    const draft = {
      name: "Internal product", description: "Internal product", price: 900,
      imageUrl: "https://cdn.example.test/internal.jpg", category: categoryId, brand: brandId,
      stock: 3, specs: {}, isActive: true,
    };
    const result = await createAdminProduct(adminDb, { uid: `${prefix}-admin`, email: "admin@example.test" }, `${prefix}-manual-key-0001`, draft);
    assert.equal((await adminDb.collection("product_private").doc(result.productId).get()).data()?.fulfilmentMode, "internal");
    await assert.rejects(
      createAdminProduct(adminDb, { uid: `${prefix}-admin`, email: "admin@example.test" }, `${prefix}-manual-key-0002`, {
        ...draft, supplierId: `${prefix}-supplier`, supplierItemCode: "SUP-1",
      }),
      /Manual products are internal/iu,
    );
  });

  await t.test("actual source configuration API requires and audits an active supplier-account mapping", async () => {
    const suffix = randomUUID().slice(0, 8);
    const password = `Zyro-${randomUUID()}!`;
    const adminEmail = `${prefix}-source-admin-${suffix}@example.test`;
    const clientApp = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-source-${suffix}`);
    const auth = getAuth(clientApp);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    try {
      const credential = await createUserWithEmailAndPassword(auth, adminEmail, password);
      await adminAuth.setCustomUserClaims(credential.user.uid, { admin: true });
      const activeA = `${prefix}-source-account-a-${suffix}`;
      const activeB = `${prefix}-source-account-b-${suffix}`;
      const inactive = `${prefix}-source-account-inactive-${suffix}`;
      const ordinary = `${prefix}-source-account-ordinary-${suffix}`;
      await Promise.all([
        ...[activeA, activeB].flatMap((uid) => [
          adminDb.collection("users").doc(uid).set({ role: "supplier", email: `${uid}@example.test` }),
          adminDb.collection("supplier_profiles").doc(uid).set({ supplierId: uid, companyName: uid, profileStatus: "active" }),
        ]),
        adminDb.collection("users").doc(inactive).set({ role: "supplier", email: `${inactive}@example.test` }),
        adminDb.collection("supplier_profiles").doc(inactive).set({ supplierId: inactive, companyName: inactive, profileStatus: "disabled" }),
        adminDb.collection("users").doc(ordinary).set({ role: "customer", email: `${ordinary}@example.test` }),
        adminDb.collection("supplier_profiles").doc(ordinary).set({ supplierId: ordinary, companyName: ordinary, profileStatus: "active" }),
      ]);
      await credential.user.getIdToken(true);
      const token = await credential.user.getIdToken();
      const sourceDraft = (id: string) => ({
        supplierId: id, supplierName: `Source ${id}`, name: `Source ${id}`, supplierType: "http", connectorType: "http",
        websiteUrl: "https://supplier.example.test", endpoint: "", sourceStatus: "inactive", enabled: false,
        priority: 100, currency: "LKR", timezone: "Asia/Colombo", syncSchedule: "Off", capabilities: [],
        authentication: { mode: "none" }, config: {}, settings: { autoSync: "Off", productLimit: "All" },
      });
      const request = (sourceId: string, source: Record<string, unknown>) => fetch(
        `http://${functionsHost}/${projectId}/us-central1/api/api/supplier-sources/${sourceId}`,
        { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ source }) },
      );
      const sourceId = `${prefix}-source-${suffix}`;
      await adminDb.collection("supplierSources").doc(sourceId).set(sourceDraft(sourceId));
      const missing = await request(sourceId, { sourceStatus: "active", enabled: true });
      assert.equal(missing.status, 422);
      const inactiveResponse = await request(sourceId, { sourceStatus: "active", enabled: true, supplierAccountId: inactive });
      assert.equal(inactiveResponse.status, 409);
      const wrongRole = await request(sourceId, { sourceStatus: "active", enabled: true, supplierAccountId: ordinary });
      assert.equal(wrongRole.status, 400);
      const valid = await request(sourceId, { sourceStatus: "active", enabled: true, supplierAccountId: activeA });
      assert.equal(valid.status, 200, await valid.text());
      assert.equal((await adminDb.collection("supplierSources").doc(sourceId).get()).data()?.supplierAccountId, activeA);
      const changed = await request(sourceId, { supplierAccountId: activeB });
      assert.equal(changed.status, 200, await changed.text());
      assert.equal((await adminDb.collection("supplierSources").doc(sourceId).get()).data()?.supplierAccountId, activeB);
      const audit = await adminDb.collection("supplier_operations_audit").where("sourceId", "==", sourceId).get();
      assert.ok(audit.docs.some((document) => document.data().previousSupplierAccountId === activeA && document.data().supplierAccountId === activeB));

      const accounts = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-accounts`, { headers: { Authorization: `Bearer ${token}` } });
      const accountBody = await accounts.json() as { accounts?: Array<{ id?: string }> };
      assert.equal(accounts.status, 200);
      const ids = new Set(accountBody.accounts?.map((account) => account.id));
      assert.equal(ids.has(activeA), true);
      assert.equal(ids.has(activeB), true);
      assert.equal(ids.has(inactive), false);
      assert.equal(ids.has(ordinary), false);
    } finally {
      await signOut(auth).catch(() => undefined);
      await deleteApp(clientApp);
    }
  });

  await t.test("Supplier Portal projects imported products through distinct source-account mappings and preserves source attribution", async () => {
    const suffix = randomUUID().slice(0, 8);
    const password = `Zyro-${randomUUID()}!`;
    const appA = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-mapped-a-${suffix}`);
    const appB = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-mapped-b-${suffix}`);
    const authA = getAuth(appA);
    const authB = getAuth(appB);
    connectAuthEmulator(authA, `http://${authHost}`, { disableWarnings: true });
    connectAuthEmulator(authB, `http://${authHost}`, { disableWarnings: true });
    try {
      const [credentialA, credentialB] = await Promise.all([
        createUserWithEmailAndPassword(authA, `${prefix}-mapped-a-${suffix}@example.test`, password),
        createUserWithEmailAndPassword(authB, `${prefix}-mapped-b-${suffix}@example.test`, password),
      ]);
      const accountA = credentialA.user.uid;
      const accountB = credentialB.user.uid;
      const sourceA = `${prefix}-connector-source-a-${suffix}`;
      const sourceB = `${prefix}-connector-source-b-${suffix}`;
      const productA = `${prefix}-mapped-product-a-${suffix}`;
      const productB = `${prefix}-mapped-product-b-${suffix}`;
      const fabricated = `${prefix}-fabricated-product-${suffix}`;
      const manual = `${prefix}-manual-product-${suffix}`;
      assert.notEqual(sourceA, accountA);
      assert.notEqual(sourceB, accountB);
      const importedProduct = (id: string, name: string) => ({
        id, name, sku: `ZY-${id}`, price: 1_200, stock: 5, isActive: true,
        imageUrl: `https://supplier.example/${id}.jpg`, updatedAt: "2026-08-13T00:00:00.000Z",
      });
      const offerA = buildSupplierProductOffer({
        sourceId: sourceA, supplierId: sourceA, supplierProductId: `item-${suffix}`, sku: `SUP-${suffix}`,
        productId: productA, price: 1_200, cost: 900, stock: 5, availability: "in_stock",
        lastSyncAt: "2026-08-13T00:00:00.000Z", reviewStatus: "approved",
        catalogPayload: importedProduct(productA, "Mapped product A"),
        supplierSnapshot: { supplierId: sourceA, sourceId: sourceA, inventoryLevel: 5 },
        pendingObservation: null, timestamp: "2026-08-13T00:00:00.000Z",
      });
      await Promise.all([
        adminDb.collection("users").doc(accountA).set({ role: "supplier", email: credentialA.user.email }),
        adminDb.collection("users").doc(accountB).set({ role: "supplier", email: credentialB.user.email }),
        adminDb.collection("supplier_profiles").doc(accountA).set({ supplierId: accountA, companyName: "Mapped A", profileStatus: "active" }),
        adminDb.collection("supplier_profiles").doc(accountB).set({ supplierId: accountB, companyName: "Mapped B", profileStatus: "active" }),
        adminDb.collection("supplierSources").doc(sourceA).set({ supplierId: sourceA, supplierAccountId: accountA, enabled: true }),
        adminDb.collection("supplierSources").doc(sourceB).set({ supplierId: sourceB, supplierAccountId: accountB, enabled: true }),
        adminDb.collection("products").doc(productA).set(importedProduct(productA, "Mapped product A")),
        adminDb.collection("products").doc(productB).set(importedProduct(productB, "Mapped product B")),
        adminDb.collection("products").doc(fabricated).set(importedProduct(fabricated, "Fabricated attribution")),
        adminDb.collection("products").doc(manual).set({ ...importedProduct(manual, "Admin manual product"), supplierId: accountA }),
        adminDb.collection("product_private").doc(productA).set({ fulfilmentMode: "supplier", supplierId: sourceA, supplierSourceId: sourceA, supplierItemCode: `SUP-${suffix}`, supplierOfferSelection: { activeOfferId: offerA.id } }),
        adminDb.collection("product_private").doc(productB).set({ fulfilmentMode: "supplier", supplierId: sourceB, supplierSourceId: sourceB, supplierItemCode: `SUP-B-${suffix}` }),
        adminDb.collection("product_private").doc(fabricated).set({ fulfilmentMode: "supplier", supplierId: sourceB, supplierSourceId: sourceA, supplierItemCode: `FAKE-${suffix}` }),
        adminDb.collection("product_private").doc(manual).set({ fulfilmentMode: "internal", supplierId: accountA, supplierSourceId: "supplier-portal" }),
        adminDb.collection("supplier_product_offers").doc(offerA.id).set(offerA),
      ]);
      const [tokenA, tokenB] = await Promise.all([credentialA.user.getIdToken(), credentialB.user.getIdToken()]);
      const portal = async (token: string) => {
        const response = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await response.json() as { products?: Array<{ id?: string }>; error?: string };
        assert.equal(response.status, 200, body.error);
        return new Set(body.products?.map((product) => product.id));
      };
      const [productsA, productsB] = await Promise.all([portal(tokenA), portal(tokenB)]);
      assert.deepEqual([...productsA], [productA]);
      assert.deepEqual([...productsB], [productB]);
      assert.equal(productsA.has(fabricated), false);
      assert.equal(productsA.has(manual), false);

      const stockResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal/products/${productA}/stock-proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({ stock: 8 }),
      });
      assert.equal(stockResponse.status, 200, await stockResponse.text());
      const stockRequest = (await adminDb.collection("supplier_product_requests").where("productId", "==", productA).where("requestType", "==", "stock_change").get()).docs[0];
      const queue = (await adminDb.collection("supplier_review_queue").doc(`portal-${stockRequest.id}`).get()).data()!;
      assert.equal(queue.supplierId, sourceA);
      assert.equal(queue.supplierAccountId, accountA);
      assert.equal(queue.sourceId, sourceA);
      assert.equal((await adminDb.collection("supplier_product_offers").doc(offerA.id).get()).data()?.supplierId, sourceA);

      await adminDb.collection("supplierSources").doc(sourceA).set({ supplierAccountId: accountB }, { merge: true });
      const [remappedA, remappedB] = await Promise.all([portal(tokenA), portal(tokenB)]);
      assert.equal(remappedA.has(productA), false);
      assert.equal(remappedB.has(productA), true);
    } finally {
      await Promise.all([signOut(authA).catch(() => undefined), signOut(authB).catch(() => undefined)]);
      await Promise.all([deleteApp(appA), deleteApp(appB)]);
    }
  });

  await t.test("Supplier Portal submission uses the canonical pending-offer contract and approval makes it purchasable", async () => {
    const suffix = randomUUID().slice(0, 8);
    const supplierEmail = `${prefix}-portal-${suffix}@example.test`;
    const password = `Zyro-${randomUUID()}!`;
    const requestId = `${prefix}-portal-request-${suffix}`;
    const categoryId = `${prefix}-portal-category-${suffix}`;
    const brandId = `${prefix}-portal-brand-${suffix}`;
    const supplierApp = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-portal-${suffix}`);
    const auth = getAuth(supplierApp);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    try {
      const credential = await createUserWithEmailAndPassword(auth, supplierEmail, password);
      const supplierUid = credential.user.uid;
      await Promise.all([
        adminDb.collection("users").doc(supplierUid).set({ role: "supplier", email: supplierEmail }),
        adminDb.collection("supplier_profiles").doc(supplierUid).set({ supplierId: supplierUid, companyName: "P1 Portal Supplier", profileStatus: "active" }),
        adminDb.collection("categories").doc(categoryId).set({ name: "Portal Category", isActive: true, subcategories: [{ id: "items", name: "Items", isActive: true }], specificationTemplate: [{ name: "Model", required: true }] }),
        adminDb.collection("brands").doc(brandId).set({ name: "Portal Brand", isActive: true }),
      ]);
      const token = await credential.user.getIdToken();
      const portalRequest = (path: string, body: Record<string, unknown>) => fetch(
        `http://${functionsHost}/${projectId}/us-central1/api/api${path}`,
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
      );
      const supplierSku = `PORTAL-${suffix}`;
      const draft = {
        name: "Portal approved product", supplierSku, brand: brandId, category: categoryId, subcategory: "items",
        productType: "Portal item", model: "PORTAL-1", description: "A complete portal product for the P1 commerce boundary.",
        price: 1_250, stock: 6, imageUrl: `https://supplier.example/${suffix}.jpg`, imageUrls: [], specs: { Model: "PORTAL-1" },
      };
      const saved = await portalRequest("/supplier-portal/requests", { requestId, requestType: "new_product", draft });
      assert.equal(saved.status, 200, await saved.text());
      const savedPayload = (await adminDb.collection("supplier_product_requests").doc(requestId).get()).data()?.productPayload || {};
      assert.equal(Object.hasOwn(savedPayload, "barcode"), false);
      const submitted = await portalRequest(`/supplier-portal/requests/${requestId}/submit`, {});
      assert.equal(submitted.status, 200, await submitted.text());

      const queueId = `portal-${requestId}`;
      let queue = (await adminDb.collection("supplier_review_queue").doc(queueId).get()).data()!;
      assert.equal(queue.comparison.comparisonStatus, "NEW_PRODUCT");
      assert.equal(queue.queueState, "queued");
      assert.equal(queue.mediaStatus, "queued");
      assert.equal(queue.productValidation.readyToPublish, false);
      assert.equal(Array.isArray(queue.managedMedia), false);
      const offerReference = adminDb.collection("supplier_product_offers").doc(String(queue.supplierOfferId));
      const pendingOffer = (await offerReference.get()).data()!;
      assert.equal(pendingOffer.reviewStatus, "review_pending");
      assert.equal(pendingOffer.pendingObservation.reviewQueueItemId, queueId);
      assert.equal((await adminDb.collection("products").doc(String(queue.productId)).get()).exists, false);

      await assert.rejects(
        decideSupplierQueueItem(adminDb, queueId, "approved", { uid: `${prefix}-admin`, email: "admin@example.test" }, {
          expectedPendingRevision: queue.supplierOfferPendingRevision,
        }),
        /not ready for an admin decision/iu,
      );
      const processed = await processSupplierReviewQueueItem(
        adminDb,
        queueId,
        `${prefix}-portal-media-worker-${suffix}`,
        Date.now(),
        { mediaDependencies: portalMediaDependencies() },
      );
      assert.deepEqual(processed, { queueItemId: queueId, outcome: "completed", state: "review_pending" });
      queue = (await adminDb.collection("supplier_review_queue").doc(queueId).get()).data()!;
      const media = queue.managedMedia as Array<Record<string, unknown>>;
      assert.equal(queue.queueState, "review_pending");
      assert.equal(queue.mediaStatus, "ready");
      assert.equal(queue.productValidation.readyToPublish, true);
      assert.equal(media.length, 1);
      assert.match(String(media[0].firebaseStorageUrl), /^https:\/\/firebasestorage\.googleapis\.com\//u);
      assert.equal((await adminDb.collection("supplier_media_assets").doc(String(media[0].contentHash)).get()).exists, true);
      const duplicateWorkerRun = await processSupplierReviewQueueItem(
        adminDb,
        queueId,
        `${prefix}-portal-media-worker-retry-${suffix}`,
        Date.now(),
        { mediaDependencies: portalMediaDependencies() },
      );
      assert.equal(duplicateWorkerRun.outcome, "skipped");
      assert.equal((await adminDb.collection("supplier_media_assets").where("contentHash", "==", media[0].contentHash).get()).size, 1);
      const sourceItem = {
        id: queueId, productName: String(queue.productName), supplierCode: String(queue.supplierCode), supplierName: String(queue.supplierName),
        costPrice: Number(queue.costPrice), marketPrice: Number(queue.marketPrice), stock: Number(queue.stock), imageUrl: String(queue.imageUrl),
        sourceId: String(queue.sourceId), supplierOfferId: String(queue.supplierOfferId), productPayload: queue.productPayload,
        supplierSnapshot: queue.supplierSnapshot, managedMedia: media, mediaStatus: "ready", comparison: queue.comparison,
        productValidation: queue.productValidation,
      };
      const reviewDraft = createSupplierReviewDraft(sourceItem);
      assert.equal(reviewDraft.fieldOwnership.stock, "supplier");
      const approvalDraft = parseSupplierApprovalDraft({
        ...reviewDraft,
        primaryImageUrl: media[0].firebaseStorageUrl,
        galleryImageUrls: [],
      });
      const approved = await decideSupplierQueueItem(adminDb, queueId, "approved", { uid: `${prefix}-admin`, email: "admin@example.test" }, {
        draft: approvalDraft,
        expectedPendingRevision: queue.supplierOfferPendingRevision,
      });
      assert.equal(approved.success, true);
      const productId = approved.productId!;
      const [product, privateProduct, effectiveOffer] = await Promise.all([
        adminDb.collection("products").doc(productId).get(),
        adminDb.collection("product_private").doc(productId).get(),
        offerReference.get(),
      ]);
      assert.equal(product.data()?.isActive, true);
      assert.equal(product.data()?.stock, 6);
      assert.equal(product.data()?.imageUrl, media[0].firebaseStorageUrl);
      assert.equal(product.data()?.media?.[0]?.firebaseStorageUrl, media[0].firebaseStorageUrl);
      assert.equal(privateProduct.data()?.fulfilmentMode, "supplier");
      assert.equal(privateProduct.data()?.supplierMedia?.[0]?.contentHash, media[0].contentHash);
      assert.equal(privateProduct.data()?.supplierOfferSelection?.activeOfferId, queue.supplierOfferId);
      assert.equal(effectiveOffer.data()?.reviewStatus, "approved");
      assert.equal(effectiveOffer.data()?.pendingObservation, null);
      assert.equal(effectiveOffer.data()?.productId, productId);

      const checkoutResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `${prefix}-portal-checkout-${suffix}`, "X-Forwarded-For": "203.0.113.61" },
        body: JSON.stringify({ customerUid: "guest", customerName: "Portal Customer", customerPhone: "0772233445", customerEmail: "portal-checkout@example.test", customerAddress: "2 Portal Road", district: "Colombo", city: "Colombo", paymentMethod: "cod", cartItems: [{ productId, quantity: 1, expectedUnitPrice: 1_250 }] }),
      });
      const checkout = await checkoutResponse.json() as { order?: { id?: string }; error?: string };
      assert.equal(checkoutResponse.status, 200, checkout.error);
      const orderPrivate = (await adminDb.collection("order_private").doc(checkout.order!.id!).get()).data()!;
      assert.equal(orderPrivate.lines[0].supplierOfferId, queue.supplierOfferId);
      assert.equal(orderPrivate.lines[0].supplierAccountId, supplierUid);
      assert.equal(orderPrivate.lines[0].supplierProductId, effectiveOffer.data()?.supplierProductId);

      const retry = await decideSupplierQueueItem(adminDb, queueId, "approved", { uid: `${prefix}-admin`, email: "admin@example.test" }, {
        draft: approvalDraft,
        expectedPendingRevision: queue.supplierOfferPendingRevision,
      });
      assert.equal(retry.success, true);
      assert.equal(retry.idempotent, true);
      await assert.rejects(
        decideSupplierQueueItem(adminDb, queueId, "approved", { uid: `${prefix}-admin`, email: "admin@example.test" }, { draft: approvalDraft, expectedPendingRevision: "a".repeat(64) }),
        /no longer pending|reload/iu,
      );

      const stockProposal = await portalRequest(`/supplier-portal/products/${productId}/stock-proposal`, { stock: 9 });
      assert.equal(stockProposal.status, 200, await stockProposal.text());
      const stockRequest = (await adminDb.collection("supplier_product_requests").where("productId", "==", productId).where("requestType", "==", "stock_change").get()).docs[0];
      const stockQueueId = `portal-${stockRequest.id}`;
      const stockQueue = (await adminDb.collection("supplier_review_queue").doc(stockQueueId).get()).data()!;
      assert.equal(stockQueue.comparison.comparisonStatus, "STOCK_CHANGED");
      assert.equal(stockQueue.productPayload.supplierFieldOwnership.stock.owner, "supplier");
      const stockSourceItem = { ...sourceItem, id: stockQueueId, stock: 9, productPayload: stockQueue.productPayload, supplierSnapshot: stockQueue.supplierSnapshot, managedMedia: stockQueue.managedMedia, comparison: stockQueue.comparison, productValidation: stockQueue.productValidation };
      const stockDraft = createSupplierReviewDraft(stockSourceItem);
      assert.equal(stockDraft.fieldOwnership.stock, "supplier");
      const stockDecision = await decideSupplierQueueItem(adminDb, stockQueueId, "approved", { uid: `${prefix}-admin`, email: "admin@example.test" }, {
        draft: parseSupplierApprovalDraft({ ...stockDraft, primaryImageUrl: media[0].firebaseStorageUrl, galleryImageUrls: [] }),
        expectedPendingRevision: stockQueue.supplierOfferPendingRevision,
      });
      assert.equal(stockDecision.success, true);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.stock, 9);

      const rejectedProposal = await portalRequest(`/supplier-portal/products/${productId}/stock-proposal`, { stock: 12 });
      assert.equal(rejectedProposal.status, 200, await rejectedProposal.text());
      const stockRequests = await adminDb.collection("supplier_product_requests").where("productId", "==", productId).where("requestType", "==", "stock_change").get();
      const newestRequest = stockRequests.docs.find((document) => document.id !== stockRequest.id)!;
      const rejectedQueueId = `portal-${newestRequest.id}`;
      const rejectedQueue = (await adminDb.collection("supplier_review_queue").doc(rejectedQueueId).get()).data()!;
      const beforeRejectOffer = (await offerReference.get()).data()!;
      const rejected = await decideSupplierQueueItem(adminDb, rejectedQueueId, "rejected", { uid: `${prefix}-admin`, email: "admin@example.test" }, { rejectionReason: "Stock evidence not accepted.", expectedPendingRevision: rejectedQueue.supplierOfferPendingRevision });
      assert.equal(rejected.success, true);
      const afterRejectOffer = (await offerReference.get()).data()!;
      assert.equal(afterRejectOffer.reviewStatus, "approved");
      assert.equal(afterRejectOffer.stock, beforeRejectOffer.stock);
      assert.equal(afterRejectOffer.pendingObservation, null);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.stock, 9);

      const skuClaimReference = adminDb.collection("supplier_sku_claims").doc(String(queue.supplierSkuClaimId));
      assert.equal((await skuClaimReference.get()).data()?.canonicalProductId, productId);
      await skuClaimReference.update({ canonicalProductId: FieldValue.delete() });

      const processAndApproveChange = async (changeRequestId: string) => {
        const changeQueueId = `portal-${changeRequestId}`;
        let changeQueue = (await adminDb.collection("supplier_review_queue").doc(changeQueueId).get()).data()!;
        assert.equal(changeQueue.queueState, "queued");
        const processedChange = await processSupplierReviewQueueItem(
          adminDb,
          changeQueueId,
          `${prefix}-change-media-worker-${changeRequestId}`,
          Date.now(),
          { mediaDependencies: portalMediaDependencies() },
        );
        assert.equal(processedChange.state, "review_pending");
        changeQueue = (await adminDb.collection("supplier_review_queue").doc(changeQueueId).get()).data()!;
        const changeMedia = changeQueue.managedMedia as Array<Record<string, unknown>>;
        const changeSourceItem = {
          id: changeQueueId,
          productName: String(changeQueue.productName),
          supplierCode: String(changeQueue.supplierCode),
          supplierName: String(changeQueue.supplierName),
          costPrice: Number(changeQueue.costPrice),
          marketPrice: Number(changeQueue.marketPrice),
          stock: Number(changeQueue.stock),
          imageUrl: String(changeQueue.imageUrl),
          sourceId: String(changeQueue.sourceId),
          supplierOfferId: String(changeQueue.supplierOfferId),
          productPayload: changeQueue.productPayload,
          supplierSnapshot: changeQueue.supplierSnapshot,
          managedMedia: changeMedia,
          mediaStatus: changeQueue.mediaStatus,
          comparison: changeQueue.comparison,
          productValidation: changeQueue.productValidation,
        };
        const changeDraft = createSupplierReviewDraft(changeSourceItem);
        const decision = await decideSupplierQueueItem(
          adminDb,
          changeQueueId,
          "approved",
          { uid: `${prefix}-admin`, email: "admin@example.test" },
          {
            draft: parseSupplierApprovalDraft({
              ...changeDraft,
              primaryImageUrl: changeMedia[0].firebaseStorageUrl,
              galleryImageUrls: changeMedia.slice(1).map((asset) => asset.firebaseStorageUrl),
            }),
            expectedPendingRevision: changeQueue.supplierOfferPendingRevision,
          },
        );
        if (!decision.success) assert.fail("A legitimate same-product edit must not create an approval conflict.");
        assert.equal(decision.productId, productId);
        return { changeQueue, changeMedia };
      };

      const editRequestId = `${requestId}-full-edit`;
      const editedDraft = {
        ...draft,
        price: 1_450,
        description: "The approved supplier product now has a complete revised description.",
        productType: "Updated portal item",
      };
      const savedEdit = await portalRequest("/supplier-portal/requests", {
        requestId: editRequestId,
        requestType: "product_change",
        productId,
        draft: editedDraft,
      });
      assert.equal(savedEdit.status, 200, await savedEdit.text());
      const submittedLegacyEdit = await portalRequest(`/supplier-portal/requests/${editRequestId}/submit`, {});
      assert.equal(submittedLegacyEdit.status, 200, await submittedLegacyEdit.text());
      await processAndApproveChange(editRequestId);
      const [editedProduct, editedPrivateProduct, ownedProducts] = await Promise.all([
        adminDb.collection("products").doc(productId).get(),
        adminDb.collection("product_private").doc(productId).get(),
        adminDb.collection("product_private").where("supplierId", "==", supplierUid).get(),
      ]);
      assert.equal(editedProduct.data()?.price, 1_450);
      assert.equal(editedProduct.data()?.description, editedDraft.description);
      assert.equal(editedProduct.data()?.productType, editedDraft.productType);
      assert.equal(editedPrivateProduct.data()?.supplierId, supplierUid);
      assert.equal(ownedProducts.docs.filter((document) => document.id === productId).length, 1);
      assert.equal((await skuClaimReference.get()).data()?.canonicalProductId, productId);

      const imageEditRequestId = `${requestId}-image-edit`;
      const imageEditDraft = {
        ...editedDraft,
        imageUrl: `https://supplier.example/${suffix}-changed-product-image.jpg`,
      };
      const savedImageEdit = await portalRequest("/supplier-portal/requests", {
        requestId: imageEditRequestId,
        requestType: "product_change",
        productId,
        draft: imageEditDraft,
      });
      assert.equal(savedImageEdit.status, 200, await savedImageEdit.text());
      const submittedImageEdit = await portalRequest(`/supplier-portal/requests/${imageEditRequestId}/submit`, {});
      assert.equal(submittedImageEdit.status, 200, await submittedImageEdit.text());
      const imageQueueBeforeWorker = (await adminDb.collection("supplier_review_queue").doc(`portal-${imageEditRequestId}`).get()).data()!;
      assert.equal(imageQueueBeforeWorker.mediaStatus, "queued");
      const imageEdit = await processAndApproveChange(imageEditRequestId);
      assert.notEqual(imageEdit.changeMedia[0].contentHash, media[0].contentHash);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.imageUrl, imageEdit.changeMedia[0].firebaseStorageUrl);

      const rejectedEditRequestId = `${requestId}-rejected-edit`;
      const rejectedEditDraft = { ...imageEditDraft, price: 1_700, description: "This edit should be rejected." };
      const savedRejectedEdit = await portalRequest("/supplier-portal/requests", {
        requestId: rejectedEditRequestId,
        requestType: "product_change",
        productId,
        draft: rejectedEditDraft,
      });
      assert.equal(savedRejectedEdit.status, 200, await savedRejectedEdit.text());
      const submittedRejectedEdit = await portalRequest(`/supplier-portal/requests/${rejectedEditRequestId}/submit`, {});
      assert.equal(submittedRejectedEdit.status, 200, await submittedRejectedEdit.text());
      const rejectedEditQueueId = `portal-${rejectedEditRequestId}`;
      await processSupplierReviewQueueItem(adminDb, rejectedEditQueueId, `${prefix}-rejected-edit-worker-${suffix}`, Date.now(), {
        mediaDependencies: portalMediaDependencies(),
      });
      const rejectedEditQueue = (await adminDb.collection("supplier_review_queue").doc(rejectedEditQueueId).get()).data()!;
      await decideSupplierQueueItem(adminDb, rejectedEditQueueId, "rejected", { uid: `${prefix}-admin`, email: "admin@example.test" }, {
        rejectionReason: "Keep the currently approved catalogue data.",
        expectedPendingRevision: rejectedEditQueue.supplierOfferPendingRevision,
      });
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.price, 1_450);
      assert.equal((await skuClaimReference.get()).data()?.canonicalProductId, productId);

      const duplicateRequestId = `${requestId}-duplicate-new`;
      const savedDuplicate = await portalRequest("/supplier-portal/requests", {
        requestId: duplicateRequestId,
        requestType: "new_product",
        draft: { ...draft, name: "A different product attempting the claimed SKU" },
      });
      assert.equal(savedDuplicate.status, 200, await savedDuplicate.text());
      const submittedDuplicate = await portalRequest(`/supplier-portal/requests/${duplicateRequestId}/submit`, {});
      assert.equal(submittedDuplicate.status, 400, await submittedDuplicate.text());

      const otherSupplierCredential = await createUserWithEmailAndPassword(
        auth,
        `${prefix}-portal-other-${suffix}@example.test`,
        `Zyro-${randomUUID()}!`,
      );
      const otherSupplierUid = otherSupplierCredential.user.uid;
      await Promise.all([
        adminDb.collection("users").doc(otherSupplierUid).set({ role: "supplier", email: otherSupplierCredential.user.email }),
        adminDb.collection("supplier_profiles").doc(otherSupplierUid).set({
          supplierId: otherSupplierUid,
          companyName: "Other P1 Portal Supplier",
          profileStatus: "active",
        }),
      ]);
      const otherSupplierToken = await otherSupplierCredential.user.getIdToken();
      const otherSupplierRequest = (path: string, body: Record<string, unknown>) => fetch(
        `http://${functionsHost}/${projectId}/us-central1/api/api${path}`,
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherSupplierToken}` }, body: JSON.stringify(body) },
      );
      const crossSupplierRequestId = `${requestId}-cross-supplier`;
      const savedCrossSupplier = await otherSupplierRequest("/supplier-portal/requests", {
        requestId: crossSupplierRequestId,
        requestType: "new_product",
        draft: { ...draft, name: "Another supplier attempting the live supplier SKU" },
      });
      assert.equal(savedCrossSupplier.status, 200, await savedCrossSupplier.text());
      const submittedCrossSupplier = await otherSupplierRequest(`/supplier-portal/requests/${crossSupplierRequestId}/submit`, {});
      assert.equal(submittedCrossSupplier.status, 400, await submittedCrossSupplier.text());
      const forgedChange = await otherSupplierRequest("/supplier-portal/requests", {
        requestId: `${requestId}-forged-change`,
        requestType: "product_change",
        productId,
        draft: imageEditDraft,
      });
      assert.equal(forgedChange.status, 403, await forgedChange.text());

      const retryEditRequestId = `${requestId}-retry-edit`;
      const savedRetryEdit = await portalRequest("/supplier-portal/requests", {
        requestId: retryEditRequestId,
        requestType: "product_change",
        productId,
        draft: { ...imageEditDraft, price: 1_500 },
      });
      assert.equal(savedRetryEdit.status, 200, await savedRetryEdit.text());
      const submittedRetryEdit = await portalRequest(`/supplier-portal/requests/${retryEditRequestId}/submit`, {});
      assert.equal(submittedRetryEdit.status, 200, await submittedRetryEdit.text());
    } finally {
      await signOut(auth).catch(() => undefined);
      await deleteApp(supplierApp);
    }
  });

  await t.test("review and question ownership migration produces public presentation plus server-only evidence", async () => {
    const reviewId = `${prefix}-legacy-review`;
    const questionId = `${prefix}-legacy-question`;
    const migrationApp = initializeAdminApp({ projectId }, `${prefix}-migration`);
    const migrationDb = getAdminFirestore(migrationApp);
    try {
      await Promise.all([
        migrationDb.collection("reviews").doc(reviewId).set({ productId: `${prefix}-product`, userId: `${prefix}-user`, orderId: `${prefix}-order`, verifiedPurchase: true, body: "Legacy public review", rating: 5 }),
        migrationDb.collection("productQuestions").doc(questionId).set({ productId: `${prefix}-product`, userId: `${prefix}-user`, question: "Legacy question?" }),
      ]);
    assert.equal(REVIEW_DOCUMENTS_PER_BATCH, 80);
    assert.equal(MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_BATCH, 400);
    assert.throws(
      () => assertReviewOwnershipMigrationAuthorized(true, "zyrolk-e0164", {}),
      /REVIEW_OWNERSHIP_MIGRATION_CONFIRM=zyrolk-e0164/u,
    );
    const dryRun = await migrateReviewOwnershipData(migrationDb, { applyRequested: false, expectedProjectId: projectId!, log: () => undefined });
    assert.ok(dryRun.documentsRequiringMigration >= 2);
    assert.equal((await migrationDb.collection("reviews").doc(reviewId).get()).data()?.userId, `${prefix}-user`);
    const result = await migrateReviewOwnershipData(migrationDb, { applyRequested: true, expectedProjectId: projectId!, log: () => undefined });
    assert.equal(result.unsafePublicDocuments, 0);
    const [review, reviewPrivate, question, questionPrivate] = await Promise.all([
      migrationDb.collection("reviews").doc(reviewId).get(),
      migrationDb.collection("review_private").doc(reviewId).get(),
      migrationDb.collection("productQuestions").doc(questionId).get(),
      migrationDb.collection("product_question_private").doc(questionId).get(),
    ]);
    assert.equal(Object.hasOwn(review.data()!, "userId"), false);
    assert.equal(Object.hasOwn(review.data()!, "orderId"), false);
    assert.equal(reviewPrivate.data()?.userId, `${prefix}-user`);
    assert.equal(Object.hasOwn(question.data()!, "userId"), false);
    assert.equal(questionPrivate.data()?.userId, `${prefix}-user`);

    const [host, portText] = firestoreHost!.split(":");
    const environment = await initializeTestEnvironment({
      projectId: projectId!,
      firestore: { host, port: Number(portText), rules: readFileSync("firestore.rules", "utf8") },
    });
    try {
      const publicDb = environment.unauthenticatedContext().firestore();
      assert.equal((await assertSucceeds(getDoc(doc(publicDb, "reviews", reviewId)))).exists(), true);
      assert.equal((await assertSucceeds(getDoc(doc(publicDb, "productQuestions", questionId)))).exists(), true);
      assert.equal((await assertSucceeds(getDocs(query(collection(publicDb, "reviews"), where("productId", "==", `${prefix}-product`))))).size >= 1, true);
      assert.equal((await assertSucceeds(getDocs(query(collection(publicDb, "productQuestions"), where("productId", "==", `${prefix}-product`))))).size >= 1, true);
      await assertFails(getDoc(doc(publicDb, "review_private", reviewId)));
      await assertFails(getDoc(doc(publicDb, "product_question_private", questionId)));
      await assertFails(setDoc(doc(publicDb, "review_private", reviewId), { userId: "attacker" }));

      const unsafeReviewId = `${prefix}-unsafe-legacy-review`;
      await migrationDb.collection("reviews").doc(unsafeReviewId).set({ productId: `${prefix}-product`, userId: "legacy-owner", orderId: "legacy-order", body: "Unsafe", rating: 4, verifiedPurchase: true });
      await assertFails(getDoc(doc(publicDb, "reviews", unsafeReviewId)));
    } finally {
      await environment.cleanup();
    }
    } finally {
      await deleteAdminApp(migrationApp);
    }
  });

  await t.test("review ownership migration is idempotent and fails closed on every protected-evidence conflict", async () => {
    const baseEvidence = {
      reviewId: `${prefix}-conflict-review`,
      productId: `${prefix}-conflict-product`,
      userId: `${prefix}-conflict-user`,
      orderId: `${prefix}-conflict-order`,
      verifiedPurchase: true,
    };
    const runScenario = async (
      scenario: string,
      privateOverrides: Record<string, unknown>,
      expectedConflict?: string,
    ) => {
      const scenarioProjectId = `${projectId}-${scenario}`;
      const app = initializeAdminApp({ projectId: scenarioProjectId }, `${prefix}-${scenario}`);
      const db = getAdminFirestore(app);
      const reviewReference = db.collection("reviews").doc(baseEvidence.reviewId);
      const privateReference = db.collection("review_private").doc(baseEvidence.reviewId);
      const publicEvidence = {
        productId: baseEvidence.productId,
        userId: baseEvidence.userId,
        orderId: baseEvidence.orderId,
        verifiedPurchase: true,
        body: "Legacy review with protected ownership evidence.",
        rating: 5,
      };
      const privateEvidence = { schemaVersion: 1, ...baseEvidence, marker: `preserve-${scenario}`, ...privateOverrides };
      try {
        await Promise.all([
          reviewReference.set(publicEvidence),
          privateReference.set(privateEvidence),
        ]);
        if (expectedConflict) {
          for (const applyRequested of [false, true]) {
            await assert.rejects(
              migrateReviewOwnershipData(db, { applyRequested, expectedProjectId: scenarioProjectId, log: () => undefined }),
              (error: unknown) => error instanceof ReviewOwnershipMigrationConflictError
                && error.message.includes(`review_private/${baseEvidence.reviewId}`)
                && error.message.includes(expectedConflict),
            );
          }
          assert.deepEqual((await reviewReference.get()).data(), publicEvidence);
          assert.deepEqual((await privateReference.get()).data(), privateEvidence);
          return;
        }
        const dryRun = await migrateReviewOwnershipData(db, { applyRequested: false, expectedProjectId: scenarioProjectId, log: () => undefined });
        assert.equal(dryRun.documentsRequiringMigration, 1);
        const applied = await migrateReviewOwnershipData(db, { applyRequested: true, expectedProjectId: scenarioProjectId, log: () => undefined });
        assert.equal(applied.migratedDocuments, 1);
        assert.equal(Object.hasOwn((await reviewReference.get()).data()!, "userId"), false);
        assert.deepEqual((await privateReference.get()).data(), privateEvidence);
        const retry = await migrateReviewOwnershipData(db, { applyRequested: true, expectedProjectId: scenarioProjectId, log: () => undefined });
        assert.equal(retry.documentsRequiringMigration, 0);
        assert.equal(retry.migratedDocuments, 0);
        assert.deepEqual((await privateReference.get()).data(), privateEvidence);
      } finally {
        await deleteAdminApp(app);
      }
    };

    await runScenario("exact-companion", {}, undefined);
    await runScenario("conflict-user", { userId: `${prefix}-other-user` }, "userId");
    await runScenario("conflict-order", { orderId: `${prefix}-other-order` }, "orderId");
    await runScenario("conflict-product", { productId: `${prefix}-other-product` }, "productId");
    await runScenario("conflict-purchase", { verifiedPurchase: false }, "verifiedPurchase");
  });

  await t.test("real review API stores ownership and purchase evidence only in server-private companions", async () => {
    const suffix = randomUUID().slice(0, 8);
    const uidEmail = `${prefix}-review-${suffix}@example.test`;
    const password = `Zyro-${randomUUID()}!`;
    const productId = `${prefix}-review-api-product-${suffix}`;
    const orderId = `${prefix}-review-api-order-${suffix}`;
    await Promise.all([
      adminDb.collection("products").doc(productId).set({ id: productId, name: "Review product", price: 500, stock: 1, isActive: true }),
      adminDb.collection("orders").doc(orderId).set({ customerUid: "pending", status: "confirmed", items: [{ productId, quantity: 1 }] }),
    ]);
    const clientApp = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-review-${suffix}`);
    const auth = getAuth(clientApp);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    try {
      const credential = await createUserWithEmailAndPassword(auth, uidEmail, password);
      await adminDb.collection("orders").doc(orderId).set({ customerUid: credential.user.uid }, { merge: true });
      const token = await credential.user.getIdToken();
      const api = (path: "reviews" | "questions", body: Record<string, unknown>) => fetch(
        `http://${functionsHost}/${projectId}/us-central1/api/api/review-system/${path}`,
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
      );
      const reviewResponse = await api("reviews", { action: "create", productId, rating: 5, title: "Excellent product", body: "This product works exactly as expected." });
      const reviewResult = await reviewResponse.json() as { reviewId?: string; error?: string };
      assert.equal(reviewResponse.status, 201, reviewResult.error);
      const questionResponse = await api("questions", { action: "create", productId, question: "Does this include the original warranty?" });
      const questionResult = await questionResponse.json() as { questionId?: string; error?: string };
      assert.equal(questionResponse.status, 201, questionResult.error);
      const [review, reviewPrivate, question, questionPrivate] = await Promise.all([
        adminDb.collection("reviews").doc(reviewResult.reviewId!).get(),
        adminDb.collection("review_private").doc(reviewResult.reviewId!).get(),
        adminDb.collection("productQuestions").doc(questionResult.questionId!).get(),
        adminDb.collection("product_question_private").doc(questionResult.questionId!).get(),
      ]);
      for (const publicDocument of [review, question]) {
        assert.equal(Object.hasOwn(publicDocument.data()!, "userId"), false);
        assert.equal(Object.hasOwn(publicDocument.data()!, "orderId"), false);
      }
      assert.equal(reviewPrivate.data()?.userId, credential.user.uid);
      assert.equal(reviewPrivate.data()?.orderId, orderId);
      assert.equal(questionPrivate.data()?.userId, credential.user.uid);

      const questionBatch = adminDb.batch();
      const beyondPreviousCapId = `${prefix}-owned-question-100`;
      for (let index = 0; index <= 100; index += 1) {
        const id = `${prefix}-owned-question-${String(index).padStart(3, "0")}`;
        questionBatch.set(adminDb.collection("productQuestions").doc(id), {
          productId,
          question: `Boundary question ${index}?`,
          customerName: "Boundary Customer",
        });
        questionBatch.set(adminDb.collection("product_question_private").doc(id), {
          questionId: id,
          productId,
          userId: index === 100 ? credential.user.uid : `${prefix}-other-owner`,
        });
      }
      await questionBatch.commit();
      const eligibilityResponse = await fetch(
        `http://${functionsHost}/${projectId}/us-central1/api/api/review-system/eligibility`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ productId, visibleQuestionIds: [beyondPreviousCapId] }),
        },
      );
      const eligibility = await eligibilityResponse.json() as { ownedQuestionIds?: string[]; error?: string };
      assert.equal(eligibilityResponse.status, 200, eligibility.error);
      assert.deepEqual(eligibility.ownedQuestionIds, [beyondPreviousCapId]);

      const update = await api("reviews", { action: "update", productId, reviewId: reviewResult.reviewId, rating: 4, title: "Updated review", body: "The product remains good after more use." });
      assert.equal(update.status, 200);
      const questionDelete = await api("questions", { action: "delete", productId, questionId: questionResult.questionId });
      assert.equal(questionDelete.status, 200);
      assert.equal((await adminDb.collection("product_question_private").doc(questionResult.questionId!).get()).exists, false);
    } finally {
      await signOut(auth).catch(() => undefined);
      await deleteApp(clientApp);
    }
  });
});
