import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import { updateOrderStatus } from "../functions/src/api/routes/orders";
import {
  addSupplierLocalDemand,
  projectSupplierAvailableStock,
  releaseSupplierLocalDemand,
  resolveSupplierLocalDemand,
  supplierObservedStockFromPrivate,
} from "../functions/src/api/orders/supplierInventoryReconciliation";
import { buildSupplierProductOffer, applyApprovedSupplierInventoryObservation } from "../functions/src/api/suppliers/supplierOfferEngine";
import { expireReservation } from "../functions/src/scheduled/paymentReservations";

const canRunEmulator = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST
  && process.env.FUNCTIONS_EMULATOR_HOST
  && String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT).startsWith("demo-"),
);

test("P1 stock authority separates supplier observation from local order demand", () => {
  assert.equal(supplierObservedStockFromPrivate(null), null);
  assert.equal(projectSupplierAvailableStock({
    currentPublicStock: 10,
    supplierObservedStock: null,
    localDemand: resolveSupplierLocalDemand(null, 8),
  }), 10);
  const legacy = resolveSupplierLocalDemand({ supplierMetadata: { inventoryLevel: 10 } }, 9);
  assert.deepEqual(legacy, { version: 1, quantity: 1, status: "legacy_bootstrap_required" });
  assert.equal(projectSupplierAvailableStock({ currentPublicStock: 9, supplierObservedStock: 9, localDemand: legacy }), 8);
  assert.equal(projectSupplierAvailableStock({ currentPublicStock: 8, supplierObservedStock: 20, localDemand: legacy }), 8);

  const tracked = { version: 1, quantity: 1, status: "tracked" as const };
  assert.equal(projectSupplierAvailableStock({ currentPublicStock: 9, supplierObservedStock: 10, localDemand: tracked }), 9);
  assert.equal(projectSupplierAvailableStock({ currentPublicStock: 9, supplierObservedStock: 9, localDemand: tracked }), 8);
  assert.equal(projectSupplierAvailableStock({ currentPublicStock: 9, supplierObservedStock: 0, localDemand: tracked }), 0);
  assert.equal(addSupplierLocalDemand(tracked, 2).quantity, 3);
  assert.deepEqual(releaseSupplierLocalDemand(legacy, 1), { version: 1, quantity: 0, status: "tracked" });
  assert.equal(releaseSupplierLocalDemand(tracked, 99).quantity, 0);
});

test("P1 inventory lifecycle paths use the private demand ledger", () => {
  const checkout = readFileSync("functions/src/api/routes/checkout.ts", "utf8");
  const orders = readFileSync("functions/src/api/routes/orders.ts", "utf8");
  const expiry = readFileSync("functions/src/scheduled/paymentReservations.ts", "utf8");
  const payments = readFileSync("functions/src/api/routes/payments.ts", "utf8");
  for (const source of [checkout, orders, expiry, payments]) {
    assert.match(source, /resolveSupplierLocalDemand/u);
    assert.match(source, /withSupplierLocalDemand/u);
  }
  assert.match(checkout, /transaction\.set\(update\.privateRef/u);
  assert.match(orders, /shouldRestoreStock/u);
  assert.match(expiry, /stockRestorationApplied: true/u);
  assert.match(payments, /stockRestorationApplied: false/u);
});

test("P1 emulator checkout, confirmation, supplier observation, cancellation, and expiry remain atomic and idempotent", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const productId = `p1-stock-${suffix}`;
  const expiryProductId = `p1-expiry-${suffix}`;
  const expiryOrderId = `p1-expiry-order-${suffix}`;
  const productRef = adminDb.collection("products").doc(productId);
  const privateRef = adminDb.collection("product_private").doc(productId);
  const offer = buildSupplierProductOffer({
    sourceId: "dropex",
    supplierId: "dropex",
    productId,
    supplierProductId: `supplier-${suffix}`,
    sku: `P1-${suffix}`,
    price: 1_500,
    cost: 800,
    stock: 10,
    stockKnown: true,
    availability: "in_stock",
    reviewStatus: "approved",
    priority: 1,
    lastSyncAt: "2026-09-25T00:00:00.000Z",
    catalogPayload: { name: "P1 stock authority" },
    supplierSnapshot: { inventoryLevel: 10, providedFields: ["stock"] },
    timestamp: "2026-09-25T00:00:00.000Z",
  });

  await Promise.all([
    productRef.set({ id: productId, name: "P1 stock authority", price: 1_500, stock: 9, isActive: true, availability: "in_stock" }),
    privateRef.set({
      productId,
      fulfilmentMode: "supplier",
      supplierId: "dropex",
      supplierSourceId: "dropex",
      sku: offer.sku,
      supplierItemCode: offer.sku,
      supplierMetadata: { inventoryLevel: 10, activeOfferId: offer.id, localDemand: { version: 1, quantity: 0, status: "tracked" } },
      supplierOfferSelection: { activeOfferId: offer.id, failoverEnabled: true },
    }),
    adminDb.collection("supplier_product_offers").doc(offer.id).set(offer),
    adminDb.collection("supplierSources").doc("dropex").set({
      supplierId: "dropex",
      supplierAccountId: `p1-account-${suffix}`,
      enabled: true,
      sourceStatus: "active",
    }),
    adminDb.collection("users").doc(`p1-account-${suffix}`).set({ role: "supplier" }),
    adminDb.collection("supplier_profiles").doc(`p1-account-${suffix}`).set({
      supplierId: "dropex",
      profileStatus: "active",
    }),
  ]);

  const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST!;
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const customerPhone = `077${Date.now().toString().slice(-7)}`;
  const checkoutResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `p1-stock-checkout-${suffix}` },
    body: JSON.stringify({
      customerUid: "guest",
      customerName: "P1 Stock Customer",
      customerPhone,
      customerEmail: "p1-stock@example.test",
      customerAddress: "P1 Stock Road",
      district: "Colombo",
      city: "Colombo",
      paymentMethod: "cod",
      cartItems: [{ productId, quantity: 1, expectedUnitPrice: 1_500 }],
    }),
  });
  const checkoutBody = await checkoutResponse.json() as { order?: { id?: string }; error?: string };
  assert.equal(checkoutResponse.status, 200, checkoutBody.error);
  const orderId = checkoutBody.order?.id;
  assert.ok(orderId);
  assert.equal((await productRef.get()).data()?.stock, 8);
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand.quantity, 1);

  const duplicateCheckoutResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `p1-stock-checkout-${suffix}` },
    body: JSON.stringify({
      customerUid: "guest",
      customerName: "P1 Stock Customer",
      customerPhone,
      customerEmail: "p1-stock@example.test",
      customerAddress: "P1 Stock Road",
      district: "Colombo",
      city: "Colombo",
      paymentMethod: "cod",
      cartItems: [{ productId, quantity: 1, expectedUnitPrice: 1_500 }],
    }),
  });
  const duplicateCheckoutBody = await duplicateCheckoutResponse.json() as { order?: { id?: string }; error?: string };
  assert.equal(duplicateCheckoutResponse.status, 200, duplicateCheckoutBody.error);
  assert.equal(duplicateCheckoutBody.order?.id, orderId);
  assert.equal((await productRef.get()).data()?.stock, 8);
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand.quantity, 1);

  await updateOrderStatus(orderId, "confirmed", undefined, adminDb);
  assert.equal((await productRef.get()).data()?.stock, 8);
  assert.equal((await adminDb.collection("orders").doc(orderId).get()).data()?.stockReservationStatus, "committed");
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand.quantity, 1);

  await applyApprovedSupplierInventoryObservation(adminDb, {
    offerId: offer.id,
    productId,
    stock: 9,
    observedAt: "2026-09-25T00:01:00.000Z",
    expectedStateVersion: offer.stateVersion,
  });
  assert.equal((await productRef.get()).data()?.stock, 8);
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand.quantity, 1);

  await updateOrderStatus(orderId, "cancelled", undefined, adminDb);
  assert.equal((await productRef.get()).data()?.stock, 9);
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand.quantity, 0);
  assert.equal((await adminDb.collection("orders").doc(orderId).get()).data()?.stockRestorationApplied, true);

  await Promise.all([
    adminDb.collection("products").doc(expiryProductId).set({ id: expiryProductId, stock: 9, isActive: true }),
    adminDb.collection("product_private").doc(expiryProductId).set({
      supplierMetadata: { inventoryLevel: 10 },
    }),
    adminDb.collection("orders").doc(expiryOrderId).set({
      status: "pending",
      paymentMethod: "cod",
      paymentStatus: "not_required",
      stockReservationStatus: "reserved",
      stockReservationExpiresAt: new Date(Date.now() - 60_000),
      stockRestorationApplied: false,
      items: [{ productId: expiryProductId, quantity: 1 }],
    }),
  ]);
  const expiryRef = adminDb.collection("orders").doc(expiryOrderId);
  assert.equal(await expireReservation(expiryRef, adminDb), true);
  assert.equal((await adminDb.collection("products").doc(expiryProductId).get()).data()?.stock, 10);
  assert.equal(await expireReservation(expiryRef, adminDb), false);
  assert.equal((await adminDb.collection("products").doc(expiryProductId).get()).data()?.stock, 10);
});
