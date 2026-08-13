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
import { adminAuth, adminDb } from "../functions/src/api/firebase";
import { createAdminProduct } from "../functions/src/api/products/adminProductManagement";
import { hashValue } from "../functions/src/api/checkout/checkoutLogic";
import { createSupplierReviewDraft } from "../src/services/supplierReviewEditor";
import { decideSupplierQueueItem, parseSupplierApprovalDraft } from "../functions/src/api/suppliers/supplierApproval";
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

const managedMedia = (identity: string) => [{
  assetId: `${identity}-asset`, supplierId: identity, sourceId: "supplier-portal", productId: identity,
  originalSupplierUrl: `https://supplier.example/${identity}.jpg`,
  originalStoragePath: `${identity}/original.jpg`, originalStorageUrl: `https://storage.example/${identity}-original.jpg`,
  firebaseStorageUrl: `https://storage.example/${identity}-large.webp`, contentHash: `${identity}-hash`,
  width: 1200, height: 1200, mimeType: "image/jpeg", fileSize: 1_000,
  uploadTimestamp: "2026-08-12T00:00:00.000Z", imageStatus: "ready", isPrimary: true, sortOrder: 0,
  variants: {
    thumbnail: { storagePath: `${identity}/thumb.webp`, storageUrl: `https://storage.example/${identity}-thumb.webp`, width: 200, height: 200, mimeType: "image/webp", fileSize: 100 },
    medium: { storagePath: `${identity}/medium.webp`, storageUrl: `https://storage.example/${identity}-medium.webp`, width: 800, height: 800, mimeType: "image/webp", fileSize: 500 },
    large: { storagePath: `${identity}/large.webp`, storageUrl: `https://storage.example/${identity}-large.webp`, width: 1200, height: 1200, mimeType: "image/webp", fileSize: 800 },
  },
}];

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
      assert.equal(queue.productValidation.readyToPublish, true);
      const offerReference = adminDb.collection("supplier_product_offers").doc(String(queue.supplierOfferId));
      const pendingOffer = (await offerReference.get()).data()!;
      assert.equal(pendingOffer.reviewStatus, "review_pending");
      assert.equal(pendingOffer.pendingObservation.reviewQueueItemId, queueId);
      assert.equal((await adminDb.collection("products").doc(String(queue.productId)).get()).exists, false);

      const media = managedMedia(`${prefix}-${suffix}`);
      await adminDb.collection("supplier_review_queue").doc(queueId).set({ managedMedia: media, mediaStatus: "ready" }, { merge: true });
      queue = (await adminDb.collection("supplier_review_queue").doc(queueId).get()).data()!;
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
      assert.equal(privateProduct.data()?.fulfilmentMode, "supplier");
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
