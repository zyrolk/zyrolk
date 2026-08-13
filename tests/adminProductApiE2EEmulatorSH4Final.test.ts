import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { adminAuth, adminDb } from "../functions/src/api/firebase";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;
const canRun = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));

test("SH-4 final manual Product API enforces the real Auth boundary and trusted persistence path", {
  skip: canRun ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(authHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);

  const suffix = randomUUID().slice(0, 8);
  const categoryId = `api-category-${suffix}`;
  const brandId = `api-brand-${suffix}`;
  const idempotencyKey = randomUUID();
  const email = `sh4-api-${suffix}@example.test`;
  const password = `Zyro-${randomUUID()}!`;
  const apiUrl = `http://${functionsHost}/${projectId}/us-central1/api/api/admin/products`;
  const draft = {
    name: "HTTP Admin Product",
    description: "Created through the actual Functions HTTP boundary.",
    price: 1_500,
    originalPrice: 1_750,
    imageUrl: "https://cdn.example.test/http-admin-product.jpg",
    imageUrls: ["https://cdn.example.test/http-admin-product.jpg"],
    category: categoryId,
    subcategory: "phones",
    brand: brandId,
    model: "HTTP-1",
    barcode: "3434567890123",
    stock: 4,
    specs: { Model: "HTTP-1" },
    isActive: true,
  };

  await Promise.all([
    adminDb.collection("categories").doc(categoryId).set({
      name: "Electronics",
      isActive: true,
      subcategories: [{ id: "phones", name: "Phones", isActive: true }],
      specificationTemplate: [{ name: "Model", required: true }],
    }),
    adminDb.collection("brands").doc(brandId).set({ name: "HTTP Brand", isActive: true }),
  ]);

  const unauthenticated = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ draft }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await adminDb.collection("products").get()).size, 0);

  const clientApp = initializeApp({ apiKey: "demo-key", projectId }, `sh4-api-${suffix}`);
  const clientAuth = getAuth(clientApp);
  connectAuthEmulator(clientAuth, `http://${authHost}`, { disableWarnings: true });
  try {
    const createdUser = await createUserWithEmailAndPassword(clientAuth, email, password);
    const ordinaryToken = await createdUser.user.getIdToken();
    const forbidden = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ordinaryToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ draft }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await adminDb.collection("products").get()).size, 0);

    await adminAuth.setCustomUserClaims(createdUser.user.uid, { admin: true });
    await signOut(clientAuth);
    const adminUser = await signInWithEmailAndPassword(clientAuth, email, password);
    const adminToken = await adminUser.user.getIdToken(true);
    const request = (body: Record<string, unknown>, key = idempotencyKey) => fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });

    const response = await request({ draft });
    assert.equal(response.status, 201);
    const created = await response.json() as { success: boolean; productId: string; sku: string };
    assert.equal(created.success, true);
    assert.match(created.productId, /^zyro-[a-f0-9]{32}$/u);
    assert.match(created.sku, /^ZY-[A-F0-9]{12}$/u);

    const [product, privateProduct, claim, audit] = await Promise.all([
      adminDb.collection("products").doc(created.productId).get(),
      adminDb.collection("product_private").doc(created.productId).get(),
      adminDb.collection("zyro_sku_claims").where("productId", "==", created.productId).get(),
      adminDb.collection("admin_product_audit").where("productId", "==", created.productId).get(),
    ]);
    assert.equal(product.data()?.id, created.productId);
    assert.equal(privateProduct.data()?.productId, created.productId);
    assert.equal(privateProduct.data()?.sku, created.sku);
    assert.equal(privateProduct.data()?.fulfilmentMode, "internal");
    assert.equal(claim.size, 1);
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].data().actor.uid, adminUser.user.uid);

    const retry = await request({ draft });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { idempotent?: boolean }).idempotent, true);
    assert.equal((await adminDb.collection("products").get()).size, 1);
    assert.equal((await adminDb.collection("admin_product_audit").where("productId", "==", created.productId).get()).size, 1);

    const conflictingRetry = await request({ draft: { ...draft, price: 1_600 } });
    assert.equal(conflictingRetry.status, 409);
    const injected = await request({ draft: { ...draft, zyroSkuClaimId: "browser-claim" } }, randomUUID());
    assert.equal(injected.status, 400);

    const checkoutResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `sh4-internal-checkout-${suffix}`,
        "X-Forwarded-For": "203.0.113.41",
      },
      body: JSON.stringify({
        customerUid: "guest",
        customerName: "Internal Product Customer",
        customerPhone: "0771234567",
        customerEmail: "internal-product@example.test",
        customerAddress: "1 Internal Product Road",
        district: "Colombo",
        city: "Colombo",
        paymentMethod: "cod",
        cartItems: [{ productId: created.productId, quantity: 1, expectedUnitPrice: draft.price }],
      }),
    });
    const checkout = await checkoutResponse.json() as { order?: { id?: string }; error?: string };
    assert.equal(checkoutResponse.status, 200, checkout.error);
    const orderPrivate = await adminDb.collection("order_private").doc(checkout.order!.id!).get();
    assert.equal(orderPrivate.data()?.lines?.[0]?.fulfilmentMode, "internal");
    assert.equal(orderPrivate.data()?.lines?.[0]?.supplierAccountId, null);
  } finally {
    await signOut(clientAuth).catch(() => undefined);
    await deleteApp(clientApp);
  }
});
