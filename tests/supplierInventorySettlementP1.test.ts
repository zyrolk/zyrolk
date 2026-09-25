import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import { updateOrderStatus } from "../functions/src/api/routes/orders";
import {
  bootstrapSupplierLocalDemandForOrder,
  prepareSupplierInventorySettlement,
  reconcileSupplierInventorySettlement,
} from "../functions/src/api/orders/supplierInventoryReconciliation";
import { buildInitialFulfilmentGroups } from "../functions/src/api/orders/orderFulfilmentGroups";
import { buildSupplierProductOffer, applyApprovedSupplierInventoryObservation } from "../functions/src/api/suppliers/supplierOfferEngine";
import { expireReservation } from "../functions/src/scheduled/paymentReservations";

const canRunEmulator = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST
  && process.env.FUNCTIONS_EMULATOR_HOST
  && String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT).startsWith("demo-"),
);

const seedSettlementFixture = async (suffix: string, options: {
  orderStatus?: string;
  groupStatus?: "assigned" | "shipped";
  stock?: number;
  localDemand?: number;
  trackingVersion?: number;
} = {}) => {
  const productId = `settlement-product-${suffix}`;
  const orderId = `settlement-order-${suffix}`;
  const accountId = `settlement-account-${suffix}`;
  const supplierProductId = `settlement-supplier-${suffix}`;
  const sku = `SETTLE-${suffix}`;
  const baselineAt = "2026-09-25T00:00:00.000Z";
  const offer = buildSupplierProductOffer({
    sourceId: "dropex",
    supplierId: "dropex",
    supplierProductId,
    sku,
    productId,
    price: 1_500,
    cost: 800,
    stock: 10,
    stockKnown: true,
    availability: "in_stock",
    reviewStatus: "approved",
    stateVersion: 1,
    health: { inventoryObservedAt: baselineAt, availability: "in_stock" },
    lastSyncAt: baselineAt,
    catalogPayload: { name: "Settlement fixture" },
    supplierSnapshot: { inventoryLevel: 10, providedFields: ["stock"] },
    timestamp: baselineAt,
  });
  const baseLine = {
    lineId: `settlement-line-${suffix}`,
    productId,
    fulfilmentMode: "supplier" as const,
    supplierAccountId: accountId,
    supplierSourceId: "dropex",
  };
  const groups = buildInitialFulfilmentGroups([baseLine], baselineAt).map((group) => ({
    ...group,
    status: options.groupStatus || "assigned",
  }));
  const privateOrder = {
    orderId,
    schemaVersion: 2,
    createdAt: baselineAt,
    updatedAt: baselineAt,
    revision: options.trackingVersion || 1,
    lines: [{
      ...baseLine,
      supplierOfferId: offer.id,
      supplierOfferStateVersion: 1,
      supplierId: "dropex",
      supplierProductId,
      supplierItemCode: sku,
      purchaseSupplierCost: 800,
      approvedOfferPrice: 1_500,
      approvedOfferStockEvidence: 10,
      capturedAt: baselineAt,
    }],
    fulfilmentGroups: groups,
    assignedSupplierAccountIds: [accountId],
    ...(options.trackingVersion === undefined ? { supplierLocalDemandTrackingVersion: 1 } : {}),
  };
  const localDemand = options.localDemand === undefined ? 1 : options.localDemand;
  const productPrivate = {
    productId,
    supplierId: "dropex",
    supplierSourceId: "dropex",
    supplierItemCode: sku,
    supplierMetadata: {
      supplierProductId,
      inventoryLevel: 10,
      activeOfferId: offer.id,
      localDemand: { version: 1, quantity: localDemand, status: "tracked" },
    },
    supplierOfferSelection: { activeOfferId: offer.id, failoverEnabled: true },
  };
  await Promise.all([
    adminDb.collection("products").doc(productId).set({
      id: productId,
      name: "Settlement fixture",
      stock: options.stock === undefined ? 9 : options.stock,
      availability: "in_stock",
      isActive: true,
    }),
    adminDb.collection("product_private").doc(productId).set(productPrivate),
    adminDb.collection("supplier_product_offers").doc(offer.id).set(offer),
    adminDb.collection("orders").doc(orderId).set({
      id: orderId,
      status: options.orderStatus || "confirmed",
      paymentMethod: "cod",
      paymentStatus: "not_required",
      stockDeducted: true,
      stockReservationStatus: "committed",
      stockRestorationApplied: false,
      items: [{ productId, quantity: 1 }],
    }),
    adminDb.collection("order_private").doc(orderId).set(privateOrder),
  ]);
  return {
    productId,
    orderId,
    offer,
    groupId: groups[0].groupId,
    accountId,
  };
};

const actionInput = (fixture: Awaited<ReturnType<typeof seedSettlementFixture>>, orderRevision: number) => ({
  db: adminDb,
  orderId: fixture.orderId,
  groupId: fixture.groupId,
  productId: fixture.productId,
  quantity: 1,
  expectedGroupRevision: 1,
  expectedOrderPrivateRevision: orderRevision,
  actorUid: "test-admin",
});

test("supplier settlement rejects stale observation, reconciles fresh stock, and is idempotent", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const fixture = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12));
  const prepared = await prepareSupplierInventorySettlement({
    ...actionInput(fixture, 1),
    manualSupplierOrderPlaced: true,
    externalSupplierOrderReference: "DROPEX-MANUAL-1",
  });
  assert.equal(prepared.status, "unresolved");
  assert.equal(prepared.idempotent, false);
  await assert.rejects(
    reconcileSupplierInventorySettlement({
      ...actionInput(fixture, 2),
      acknowledgeFreshSupplierObservation: true,
    }),
    /fresh supplier observation/u,
  );
  assert.equal((await adminDb.collection("products").doc(fixture.productId).get()).data()?.stock, 9);

  await applyApprovedSupplierInventoryObservation(adminDb, {
    offerId: fixture.offer.id,
    productId: fixture.productId,
    stock: 9,
    observedAt: "2026-09-26T00:00:00.000Z",
    expectedStateVersion: 1,
  });
  assert.equal((await adminDb.collection("products").doc(fixture.productId).get()).data()?.stock, 8);
  const reconciled = await reconcileSupplierInventorySettlement({
    ...actionInput(fixture, 2),
    acknowledgeFreshSupplierObservation: true,
  });
  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.publicStock, 9);
  assert.equal((await adminDb.collection("product_private").doc(fixture.productId).get()).data()?.supplierMetadata.localDemand.quantity, 0);
  assert.equal((await adminDb.collection("products").doc(fixture.productId).get()).data()?.supplierMetadata, undefined);
  const repeated = await reconcileSupplierInventorySettlement({
    ...actionInput(fixture, 3),
    acknowledgeFreshSupplierObservation: true,
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.publicStock, 9);
  const privateOrder = (await adminDb.collection("order_private").doc(fixture.orderId).get()).data()!;
  assert.equal(privateOrder.supplierInventorySettlements[0].status, "reconciled");
  assert.equal(privateOrder.supplierInventorySettlements[0].quantity, 1);
  assert.equal((await adminDb.collection("supplier_operations_audit").where("orderId", "==", fixture.orderId).get()).size, 2);
});

test("supplier settlement requires a fresh lower observation and protects source/identity fences", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const fixture = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12));
  await prepareSupplierInventorySettlement({ ...actionInput(fixture, 1), manualSupplierOrderPlaced: true });
  await assert.rejects(
    reconcileSupplierInventorySettlement({ ...actionInput(fixture, 2), acknowledgeFreshSupplierObservation: true }),
    /fresh supplier observation/u,
  );
  await adminDb.collection("product_private").doc(fixture.productId).update({ supplierSourceId: "a2z" });
  await assert.rejects(
    reconcileSupplierInventorySettlement({ ...actionInput(fixture, 2), acknowledgeFreshSupplierObservation: true }),
    /supplier identity/u,
  );
});

test("supplier cancellation restores only unresolved demand and delivery does not release it", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const before = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12));
  await updateOrderStatus(before.orderId, "cancelled", undefined, adminDb);
  assert.equal((await adminDb.collection("products").doc(before.productId).get()).data()?.stock, 10);
  assert.equal((await adminDb.collection("product_private").doc(before.productId).get()).data()?.supplierMetadata.localDemand.quantity, 0);

  const after = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12));
  await prepareSupplierInventorySettlement({ ...actionInput(after, 1), manualSupplierOrderPlaced: true });
  await applyApprovedSupplierInventoryObservation(adminDb, {
    offerId: after.offer.id,
    productId: after.productId,
    stock: 9,
    observedAt: "2026-09-26T00:00:00.000Z",
    expectedStateVersion: 1,
  });
  await reconcileSupplierInventorySettlement({ ...actionInput(after, 2), acknowledgeFreshSupplierObservation: true });
  const orderPrivate = await adminDb.collection("order_private").doc(after.orderId).get();
  await updateOrderStatus(after.orderId, "cancelled", undefined, adminDb, {
    adminUid: "test-admin",
    expectedOrderPrivateRevision: orderPrivate.data()?.revision,
    expectedGroupRevisions: { [after.groupId]: 1 },
  });
  assert.equal((await adminDb.collection("products").doc(after.productId).get()).data()?.stock, 9);

  const delivered = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12), {
    orderStatus: "shipped",
    groupStatus: "shipped",
  });
  await updateOrderStatus(delivered.orderId, "delivered", undefined, adminDb, {
    adminUid: "test-admin",
    expectedOrderPrivateRevision: 1,
    expectedGroupRevisions: { [delivered.groupId]: 1 },
  });
  assert.equal((await adminDb.collection("products").doc(delivered.productId).get()).data()?.stock, 9);
  assert.equal((await adminDb.collection("product_private").doc(delivered.productId).get()).data()?.supplierMetadata.localDemand.quantity, 1);
});

test("supplier settlement races converge to one reconciliation and expiry respects settled demand", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const fixture = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12));
  await prepareSupplierInventorySettlement({ ...actionInput(fixture, 1), manualSupplierOrderPlaced: true });
  await applyApprovedSupplierInventoryObservation(adminDb, {
    offerId: fixture.offer.id,
    productId: fixture.productId,
    stock: 9,
    observedAt: "2026-09-26T00:00:00.000Z",
    expectedStateVersion: 1,
  });
  const results = await Promise.allSettled([
    reconcileSupplierInventorySettlement({ ...actionInput(fixture, 2), acknowledgeFreshSupplierObservation: true }),
    reconcileSupplierInventorySettlement({ ...actionInput(fixture, 2), acknowledgeFreshSupplierObservation: true }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await adminDb.collection("products").doc(fixture.productId).get()).data()?.stock, 9);
  assert.equal((await adminDb.collection("product_private").doc(fixture.productId).get()).data()?.supplierMetadata.localDemand.quantity, 0);

  const expiry = await seedSettlementFixture(randomUUID().replaceAll("-", "").slice(0, 12));
  await prepareSupplierInventorySettlement({ ...actionInput(expiry, 1), manualSupplierOrderPlaced: true });
  await adminDb.collection("orders").doc(expiry.orderId).update({
    status: "pending",
    paymentMethod: "cod",
    paymentStatus: "not_required",
    stockReservationStatus: "reserved",
    stockReservationExpiresAt: new Date(Date.now() - 60_000),
  });
  await adminDb.collection("order_private").doc(expiry.orderId).update({ supplierInventorySettlements: [{
    settlementId: "supplier-settlement-test",
    orderId: expiry.orderId,
    groupId: expiry.groupId,
    productId: expiry.productId,
    quantity: 1,
    status: "reconciled",
    supplierSourceId: "dropex",
    supplierAccountId: expiry.accountId,
    baselineSupplierObservedStock: 10,
    baselineSupplierObservationVersion: 1,
    baselineSupplierObservationAt: "2026-09-25T00:00:00.000Z",
    preparedAt: "2026-09-25T00:00:01.000Z",
    preparedBy: "test-admin",
  }] });
  assert.equal(await expireReservation(adminDb.collection("orders").doc(expiry.orderId), adminDb), true);
  assert.equal((await adminDb.collection("products").doc(expiry.productId).get()).data()?.stock, 9);
});

test("legacy active order bootstrap is dry-run, bounded, idempotent, and skips terminal orders", {
  skip: canRunEmulator ? undefined : "Firestore and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const legacy = await seedSettlementFixture(`legacy-${suffix}`, { trackingVersion: 0 });
  const privateRef = adminDb.collection("product_private").doc(legacy.productId);
  await privateRef.update({ "supplierMetadata.localDemand": null });
  const dryRun = await bootstrapSupplierLocalDemandForOrder(adminDb, legacy.orderId);
  assert.equal(dryRun.status, "would_bootstrap");
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand, null);
  const applied = await bootstrapSupplierLocalDemandForOrder(adminDb, legacy.orderId, { dryRun: false });
  assert.equal(applied.status, "bootstrapped");
  assert.equal((await privateRef.get()).data()?.supplierMetadata.localDemand.quantity, 1);
  const repeated = await bootstrapSupplierLocalDemandForOrder(adminDb, legacy.orderId, { dryRun: false });
  assert.equal(repeated.status, "already_tracked");

  for (const status of ["delivered", "cancelled"]) {
    const terminal = await seedSettlementFixture(`legacy-${status}-${suffix}`, { orderStatus: status, trackingVersion: 0 });
    await adminDb.collection("product_private").doc(terminal.productId).update({ "supplierMetadata.localDemand": null });
    const skipped = await bootstrapSupplierLocalDemandForOrder(adminDb, terminal.orderId, { dryRun: false });
    assert.equal(skipped.status, "skipped");
    assert.equal((await adminDb.collection("product_private").doc(terminal.productId).get()).data()?.supplierMetadata.localDemand, null);
  }
});
