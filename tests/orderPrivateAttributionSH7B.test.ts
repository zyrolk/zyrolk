import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { adminDb } from "../functions/src/api/firebase";
import {
  ORDER_PRIVATE_COLLECTION,
  OrderPrivateDocument,
} from "../functions/src/api/orders/orderPrivateAttribution";
import {
  buildSupplierProductOffer,
  reconcileSupplierProductOfferFailover,
  SupplierProductOffer,
} from "../functions/src/api/suppliers/supplierOfferEngine";
import { saveSupplierSource } from "../functions/src/api/suppliers/supplierAdminConfiguration";
import { SUPPLIER_PORTAL_SOURCE_ID } from "../functions/src/api/suppliers/supplierPortalLogic";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRun = Boolean(firestoreHost && functionsHost && projectId?.startsWith("demo-"));
const fixturePrefix = "sh7b-order-private";

interface SupplierFixture {
  accountId: string;
  offer: SupplierProductOffer;
  productId: string;
  sourceId: string;
  supplierId: string;
  supplierProductId: string;
  supplierItemCode: string;
  zyroSku: string;
}

const seedSupplierAccount = async (accountId: string, active = true): Promise<void> => {
  await Promise.all([
    adminDb.collection("users").doc(accountId).set({ role: "supplier", email: `${accountId}@example.test` }),
    adminDb.collection("supplier_profiles").doc(accountId).set({
      supplierId: accountId,
      companyName: accountId,
      profileStatus: active ? "active" : "disabled",
    }),
  ]);
};

const seedSupplierProduct = async (
  scenario: string,
  options: { mapped?: boolean; activeAccount?: boolean; portal?: boolean; publicPrice?: number; offerPrice?: number } = {},
): Promise<SupplierFixture> => {
  const productId = `${fixturePrefix}-${scenario}-product`;
  const accountId = `${fixturePrefix}-${scenario}-account`;
  const sourceId = options.portal ? SUPPLIER_PORTAL_SOURCE_ID : `${fixturePrefix}-${scenario}-source`;
  const supplierId = options.portal ? accountId : `${fixturePrefix}-${scenario}-supplier`;
  const supplierProductId = `${fixturePrefix}-${scenario}-supplier-product`;
  const supplierItemCode = `SUP-${scenario.toUpperCase()}`;
  const zyroSku = `ZY-SH7B-${scenario.toUpperCase()}`;
  const timestamp = new Date().toISOString();
  const offer = buildSupplierProductOffer({
    sourceId,
    supplierId,
    supplierProductId,
    sku: supplierItemCode,
    barcode: "1234567890123",
    productId,
    price: options.offerPrice ?? 1_200,
    cost: 850,
    stock: 12,
    availability: "in_stock",
    priority: 100,
    health: { availability: "available", sourceAvailability: "available" },
    lastSyncAt: timestamp,
    enabled: true,
    reviewStatus: "approved",
    stateVersion: 7,
    catalogPayload: { name: `SH-7B ${scenario}` },
    supplierSnapshot: { supplierProductId },
    timestamp,
  });
  await seedSupplierAccount(accountId, options.activeAccount !== false);
  const writes: Array<Promise<unknown>> = [
    adminDb.collection("products").doc(productId).set({
      id: productId,
      name: `SH-7B ${scenario}`,
      price: options.publicPrice ?? 1_500,
      stock: 8,
      imageUrl: "https://cdn.example.test/sh7b.jpg",
      isActive: true,
    }),
    adminDb.collection("product_private").doc(productId).set({
      productId,
      sku: zyroSku,
      supplierId,
      supplierSourceId: sourceId,
      supplierItemCode,
      supplierOfferSelection: { activeOfferId: offer.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: offer.id, supplierProductId, inventoryLevel: offer.stock },
    }),
    adminDb.collection("supplier_product_offers").doc(offer.id).set(offer),
  ];
  if (!options.portal) {
    writes.push(adminDb.collection("supplierSources").doc(sourceId).set({
      supplierId,
      supplierAccountId: options.mapped === false ? "" : accountId,
      supplierName: `SH-7B ${scenario} source`,
      connectorType: "http",
      sourceStatus: "active",
      enabled: true,
      priority: 100,
      authentication: { mode: "none" },
    }));
  }
  await Promise.all(writes);
  return { accountId, offer, productId, sourceId, supplierId, supplierProductId, supplierItemCode, zyroSku };
};

const seedInternalProduct = async (scenario: string): Promise<{ productId: string; zyroSku: string }> => {
  const productId = `${fixturePrefix}-${scenario}-internal-product`;
  const zyroSku = `ZY-SH7B-${scenario.toUpperCase()}-INTERNAL`;
  await Promise.all([
    adminDb.collection("products").doc(productId).set({
      id: productId,
      name: `SH-7B ${scenario} internal`,
      price: 900,
      stock: 5,
      imageUrl: "",
      isActive: true,
    }),
    adminDb.collection("product_private").doc(productId).set({ productId, sku: zyroSku }),
  ]);
  return { productId, zyroSku };
};

let phoneSequence = 77_100_000;
const checkout = async (scenario: string, cartItems: Array<{ productId: string; quantity: number }>, idempotencyKey = `${fixturePrefix}-${scenario}-key`) => {
  phoneSequence += 1;
  const body = {
    customerUid: "guest",
    customerName: `SH-7B ${scenario}`,
    customerPhone: `0${phoneSequence}`,
    customerEmail: `${scenario}@example.test`,
    customerAddress: "1 Emulator Road",
    district: "Colombo",
    city: "Colombo",
    paymentMethod: "cod",
    cartItems,
  };
  const response = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { success?: boolean; error?: string; order?: { id: string; items: Array<Record<string, unknown>> } };
  return { body, response, payload };
};

const readPrivateOrder = async (orderId: string): Promise<OrderPrivateDocument> => {
  const snapshot = await adminDb.collection(ORDER_PRIVATE_COLLECTION).doc(orderId).get();
  assert.equal(snapshot.exists, true);
  return snapshot.data() as OrderPrivateDocument;
};

test("SH-7B captures immutable purchase-time supplier attribution through the real checkout transaction", {
  skip: canRun ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 240_000,
}, async (t) => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);

  await t.test("supplier source configuration accepts only an active Supplier Portal account mapping", async () => {
    const activeAccountId = `${fixturePrefix}-configuration-active`;
    const inactiveAccountId = `${fixturePrefix}-configuration-inactive`;
    await Promise.all([seedSupplierAccount(activeAccountId), seedSupplierAccount(inactiveAccountId, false)]);
    const sourceDraft = (supplierAccountId: string) => ({
      supplierAccountId,
      supplierName: "SH-7B configured source",
      supplierType: "http",
      connectorType: "http",
      websiteUrl: "https://supplier.example.test",
      sourceStatus: "active",
      authentication: { mode: "none" },
      settings: { autoSync: "Off", productLimit: "All" },
    });
    const sourceId = `${fixturePrefix}-configured-source`;
    await saveSupplierSource(adminDb, sourceId, sourceDraft(activeAccountId), {
      uid: `${fixturePrefix}-admin`,
      email: "admin@example.test",
    }, { createOnly: true });
    assert.equal((await adminDb.collection("supplierSources").doc(sourceId).get()).data()?.supplierAccountId, activeAccountId);
    await assert.rejects(
      saveSupplierSource(adminDb, `${sourceId}-inactive`, sourceDraft(inactiveAccountId), {
        uid: `${fixturePrefix}-admin`,
        email: "admin@example.test",
      }, { createOnly: true }),
      /active Supplier Portal profile/i,
    );
  });

  await t.test("supplier-backed checkout records the exact approved offer without changing customer price", async () => {
    const fixture = await seedSupplierProduct("single", { publicPrice: 1_500, offerPrice: 1_200 });
    const result = await checkout("single", [{ productId: fixture.productId, quantity: 1 }]);
    assert.equal(result.response.status, 200, result.payload.error);
    const order = result.payload.order!;
    const privateOrder = await readPrivateOrder(order.id);
    assert.equal(privateOrder.orderId, order.id);
    assert.equal(privateOrder.schemaVersion, 2);
    assert.equal(privateOrder.revision, 1);
    assert.equal(privateOrder.lines.length, 1);
    assert.match(privateOrder.lines[0].lineId, /^line-[a-f0-9]{32}$/u);
    assert.deepEqual(privateOrder.lines[0], {
      lineId: privateOrder.lines[0].lineId,
      productId: fixture.productId,
      zyroSku: fixture.zyroSku,
      fulfilmentMode: "supplier",
      supplierOfferId: fixture.offer.id,
      supplierOfferStateVersion: 7,
      supplierSourceId: fixture.sourceId,
      supplierId: fixture.supplierId,
      supplierAccountId: fixture.accountId,
      supplierProductId: fixture.supplierProductId,
      supplierItemCode: fixture.supplierItemCode,
      purchaseSupplierCost: 850,
      approvedOfferPrice: 1_200,
      approvedOfferStockEvidence: 12,
      capturedAt: privateOrder.createdAt,
    });
    assert.equal(order.items[0].price, 1_500);
    const publicOrderJson = JSON.stringify((await adminDb.collection("orders").doc(order.id).get()).data());
    for (const privateField of ["purchaseSupplierCost", "supplierOfferId", "supplierAccountId", "supplierItemCode"]) {
      assert.doesNotMatch(publicOrderJson, new RegExp(privateField, "u"));
    }

    const retryResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `${fixturePrefix}-single-key` },
      body: JSON.stringify(result.body),
    });
    const retry = await retryResponse.json() as { order: { id: string } };
    assert.equal(retryResponse.status, 200);
    assert.equal(retry.order.id, order.id);
    assert.deepEqual(await readPrivateOrder(order.id), privateOrder);
  });

  await t.test("mixed supplier carts capture independent immutable line attribution", async () => {
    const supplierA = await seedSupplierProduct("mixed-a");
    const supplierB = await seedSupplierProduct("mixed-b", { portal: true });
    const result = await checkout("mixed", [
      { productId: supplierA.productId, quantity: 1 },
      { productId: supplierB.productId, quantity: 2 },
    ]);
    assert.equal(result.response.status, 200, result.payload.error);
    const privateOrder = await readPrivateOrder(result.payload.order!.id);
    assert.equal(privateOrder.lines.length, 2);
    const byProduct = new Map(privateOrder.lines.map((line) => [line.productId, line]));
    assert.equal(byProduct.get(supplierA.productId)?.supplierAccountId, supplierA.accountId);
    assert.equal(byProduct.get(supplierB.productId)?.supplierAccountId, supplierB.accountId);
    assert.equal(byProduct.get(supplierB.productId)?.supplierSourceId, SUPPLIER_PORTAL_SOURCE_ID);
    assert.notEqual(byProduct.get(supplierA.productId)?.supplierOfferId, byProduct.get(supplierB.productId)?.supplierOfferId);
  });

  await t.test("offer failover and mutable catalogue/source changes cannot rewrite historical attribution", async () => {
    const selected = await seedSupplierProduct("history-a");
    const result = await checkout("history", [{ productId: selected.productId, quantity: 1 }]);
    assert.equal(result.response.status, 200, result.payload.error);
    const orderId = result.payload.order!.id;
    const before = await readPrivateOrder(orderId);

    const replacementSourceId = `${fixturePrefix}-history-b-source`;
    const replacementSupplierId = `${fixturePrefix}-history-b-supplier`;
    const replacementAccountId = `${fixturePrefix}-history-b-account`;
    await seedSupplierAccount(replacementAccountId);
    const replacement = buildSupplierProductOffer({
      sourceId: replacementSourceId,
      supplierId: replacementSupplierId,
      supplierProductId: `${fixturePrefix}-history-b-product`,
      sku: "SUP-HISTORY-B",
      productId: selected.productId,
      price: 1_100,
      cost: 800,
      stock: 20,
      availability: "in_stock",
      priority: 90,
      health: { availability: "available", sourceAvailability: "available" },
      lastSyncAt: new Date().toISOString(),
      enabled: true,
      reviewStatus: "approved",
      stateVersion: 3,
      timestamp: new Date().toISOString(),
    });
    await Promise.all([
      adminDb.collection("supplierSources").doc(replacementSourceId).set({
        supplierId: replacementSupplierId,
        supplierAccountId: replacementAccountId,
        supplierName: "Replacement",
        connectorType: "http",
        sourceStatus: "active",
        enabled: true,
        authentication: { mode: "none" },
      }),
      adminDb.collection("supplier_product_offers").doc(replacement.id).set(replacement),
      adminDb.collection("supplier_product_offers").doc(selected.offer.id).set({
        ...selected.offer,
        stock: 0,
        availability: "unavailable",
        health: { availability: "unavailable", sourceAvailability: "unavailable" },
        stateVersion: selected.offer.stateVersion + 1,
      }),
    ]);
    const failover = await reconcileSupplierProductOfferFailover(adminDb, selected.productId, "sh7b-test");
    assert.equal(failover.activeOfferId, replacement.id);
    await Promise.all([
      adminDb.collection("supplierSources").doc(selected.sourceId).set({ supplierAccountId: replacementAccountId }, { merge: true }),
      adminDb.collection("product_private").doc(selected.productId).set({ supplierItemCode: "MUTATED-LATER" }, { merge: true }),
    ]);
    assert.deepEqual(await readPrivateOrder(orderId), before);
  });

  await t.test("missing mapping and inactive supplier accounts fail closed without partial checkout writes", async () => {
    for (const [scenario, options] of [
      ["missing-map", { mapped: false }],
      ["inactive-account", { activeAccount: false }],
    ] as const) {
      const fixture = await seedSupplierProduct(scenario, options);
      const result = await checkout(scenario, [{ productId: fixture.productId, quantity: 1 }]);
      assert.equal(result.response.status, 409);
      assert.match(result.payload.error || "", /supplier (routing is not configured|account is not active)/iu);
      assert.equal((await adminDb.collection("products").doc(fixture.productId).get()).data()?.stock, 8);
    }
  });

  await t.test("a legitimate internal product records null supplier evidence", async () => {
    const fixture = await seedInternalProduct("internal");
    const result = await checkout("internal", [{ productId: fixture.productId, quantity: 1 }]);
    assert.equal(result.response.status, 200, result.payload.error);
    const line = (await readPrivateOrder(result.payload.order!.id)).lines[0];
    assert.equal(line.fulfilmentMode, "internal");
    assert.equal(line.zyroSku, fixture.zyroSku);
    for (const value of [line.supplierOfferId, line.supplierSourceId, line.supplierId, line.supplierAccountId,
      line.supplierProductId, line.supplierItemCode, line.purchaseSupplierCost]) {
      assert.equal(value, null);
    }
  });

  await t.test("rules keep order_private server-only while legacy customer orders remain readable", async () => {
    const [host, portText] = firestoreHost!.split(":");
    const customerUid = `${fixturePrefix}-customer`;
    const supplierUid = `${fixturePrefix}-rules-supplier`;
    const legacyOrderId = `${fixturePrefix}-legacy-order`;
    await Promise.all([
      adminDb.collection("orders").doc(legacyOrderId).set({
        customerUid,
        orderNumber: "SH7B-LEGACY",
        status: "pending",
        items: [],
      }),
      seedSupplierAccount(supplierUid),
    ]);
    assert.equal((await adminDb.collection(ORDER_PRIVATE_COLLECTION).doc(legacyOrderId).get()).exists, false);

    const environment = await initializeTestEnvironment({
      projectId: projectId!,
      firestore: { host, port: Number(portText), rules: readFileSync("firestore.rules", "utf8") },
    });
    try {
      const customerDb = environment.authenticatedContext(customerUid).firestore();
      const supplierDb = environment.authenticatedContext(supplierUid).firestore();
      const privateReference = doc(customerDb, ORDER_PRIVATE_COLLECTION, legacyOrderId);
      await assertSucceeds(getDoc(doc(customerDb, "orders", legacyOrderId)));
      await assertFails(getDoc(privateReference));
      await assertFails(setDoc(privateReference, { orderId: legacyOrderId, lines: [] }));
      await assertFails(deleteDoc(privateReference));
      await assertFails(getDoc(doc(supplierDb, ORDER_PRIVATE_COLLECTION, legacyOrderId)));
    } finally {
      await environment.cleanup();
    }
  });
});
