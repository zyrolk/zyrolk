import assert from "node:assert/strict";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import { updateOrderStatus } from "../functions/src/api/routes/orders";
import {
  assignOrderToSupplier,
  transitionSupplierOrderFulfilment,
} from "../functions/src/api/routes/supplierPortal";
import { expireReservation } from "../functions/src/scheduled/paymentReservations";
import {
  buildOrderPrivateDocument,
  type OrderPrivateAttributionLine,
} from "../functions/src/api/orders/orderPrivateAttribution";
import { recordOrderFulfilmentTracking } from "../functions/src/api/orders/orderFulfilmentGroups";

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const fixturePrefix = "sh7a-fulfilment-safety";
const supplierA = `${fixturePrefix}-supplier-a`;
const supplierB = `${fixturePrefix}-supplier-b`;

interface SeedOverrides {
  status?: string;
  stockReservationStatus?: string;
  stockRestorationApplied?: boolean;
  supplierId?: string;
  supplierIds?: string[];
  supplierFulfilmentStatus?: string;
}

const seedSupplier = async (supplierId: string): Promise<void> => {
  await Promise.all([
    adminDb.collection("users").doc(supplierId).set({ role: "supplier", email: `${supplierId}@example.test` }),
    adminDb.collection("supplier_profiles").doc(supplierId).set({
      supplierId,
      companyName: supplierId,
      profileStatus: "active",
    }),
  ]);
};

const seedOrder = async (scenario: string, overrides: SeedOverrides = {}) => {
  const productId = `${fixturePrefix}-${scenario}-product`;
  const orderId = `${fixturePrefix}-${scenario}-order`;
  const productReference = adminDb.collection("products").doc(productId);
  const orderReference = adminDb.collection("orders").doc(orderId);
  const line: OrderPrivateAttributionLine = {
    lineId: `${fixturePrefix}-${scenario}-line`,
    productId,
    zyroSku: `ZY-${scenario}`,
    fulfilmentMode: "supplier",
    supplierOfferId: `${fixturePrefix}-${scenario}-offer`,
    supplierOfferStateVersion: 1,
    supplierSourceId: "supplier-portal",
    supplierId: supplierA,
    supplierAccountId: supplierA,
    supplierProductId: `${fixturePrefix}-${scenario}-supplier-product`,
    supplierItemCode: `SUP-${scenario}`,
    purchaseSupplierCost: 700,
    approvedOfferPrice: 1_000,
    approvedOfferStockEvidence: 10,
    capturedAt: new Date().toISOString(),
  };
  const privateOrder = buildOrderPrivateDocument(orderId, [line], line.capturedAt);
  const requestedStatus = String(overrides.supplierFulfilmentStatus || "pending");
  const groupStatus = requestedStatus === "accepted" || requestedStatus === "processing" || requestedStatus === "packed" || requestedStatus === "shipped"
    ? requestedStatus
    : overrides.supplierId || overrides.supplierIds?.length ? "assigned" : "unassigned";
  privateOrder.fulfilmentGroups[0] = {
    ...privateOrder.fulfilmentGroups[0],
    status: groupStatus,
    assignedAt: groupStatus === "unassigned" ? null : line.capturedAt,
    assignedBy: groupStatus === "unassigned" ? null : "sh7a-admin",
    acceptedAt: ["accepted", "processing", "packed", "shipped"].includes(groupStatus) ? line.capturedAt : null,
    processingAt: ["processing", "packed", "shipped"].includes(groupStatus) ? line.capturedAt : null,
    packedAt: ["packed", "shipped"].includes(groupStatus) ? line.capturedAt : null,
    shippedAt: groupStatus === "shipped" ? line.capturedAt : null,
  };
  privateOrder.assignedSupplierAccountIds = groupStatus === "unassigned" ? [] : [supplierA];
  await Promise.all([
    productReference.set({
      id: productId,
      name: `SH-7A ${scenario}`,
      price: 1_000,
      stock: 8,
      isActive: true,
    }),
    orderReference.set({
      orderNumber: `SH7A-${scenario}`,
      status: "pending",
      paymentMethod: "cod",
      paymentStatus: "not_required",
      stockDeducted: true,
      stockReservationStatus: "reserved",
      stockReservationExpiresAt: new Date(Date.now() - 60_000),
      stockRestorationApplied: false,
      supplierFulfilmentStatus: "pending",
      supplierAssignmentActive: groupStatus !== "unassigned",
      items: [{ productId, name: `SH-7A ${scenario}`, price: 1_000, quantity: 2 }],
      ...overrides,
    }),
    adminDb.collection("order_private").doc(orderId).set(privateOrder),
    adminDb.collection("supplier_notifications").doc(`order-${orderId}-${supplierA}`).delete(),
    adminDb.collection("supplier_notifications").doc(`order-${orderId}-${supplierB}`).delete(),
  ]);
  return { orderId, productId, orderReference, productReference, groupId: privateOrder.fulfilmentGroups[0].groupId };
};

const assign = (fixture: Awaited<ReturnType<typeof seedOrder>>, supplierId = supplierA) => assignOrderToSupplier(
  adminDb, fixture.orderId, fixture.groupId, supplierId, 1, 1, "sh7a-admin",
);

const transition = (
  fixture: Awaited<ReturnType<typeof seedOrder>>,
  status: string,
  groupRevision: number,
  privateRevision: number,
) => status === "shipped"
  ? recordOrderFulfilmentTracking({
    db: adminDb,
    orderId: fixture.orderId,
    groupId: fixture.groupId,
    supplierAccountId: supplierA,
    expectedGroupRevision: groupRevision,
    expectedOrderPrivateRevision: privateRevision,
    courierName: "SH-7A Test Courier",
    trackingNumber: `SH7A-${fixture.orderId}`,
  })
  : transitionSupplierOrderFulfilment(
    adminDb, fixture.orderId, supplierA, fixture.groupId, status, groupRevision, privateRevision,
  );

const readState = async (orderId: string, productId: string) => {
  const [order, product] = await Promise.all([
    adminDb.collection("orders").doc(orderId).get(),
    adminDb.collection("products").doc(productId).get(),
  ]);
  return { order: order.data()!, product: product.data()! };
};

test("SH-7A fences assignment, fulfilment, expiry, cancellation, and stock restoration transactionally", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 180_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.ok(String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").startsWith("demo-"));
  await Promise.all([seedSupplier(supplierA), seedSupplier(supplierB)]);

  await t.test("pending orders cannot be assigned, while confirmed committed orders can", async () => {
    const pending = await seedOrder("assignment-pending");
    await assert.rejects(assign(pending), /confirmed active order/i);
    assert.equal((await pending.orderReference.get()).data()?.supplierId, undefined);

    const confirmed = await seedOrder("assignment-confirmed", {
      status: "confirmed",
      stockReservationStatus: "committed",
    });
    await assign(confirmed);
    const order = (await confirmed.orderReference.get()).data()!;
    assert.equal(order.supplierAssignmentActive, true);
    assert.equal(order.supplierFulfilmentStatus, "pending");
  });

  await t.test("supplier processing requires confirmed order state and committed inventory", async () => {
    const pending = await seedOrder("processing-pending", {
      supplierId: supplierA,
      supplierIds: [supplierA],
    });
    await assert.rejects(
      transition(pending, "accepted", 1, 1),
      /confirmed active order/i,
    );

    const confirmed = await seedOrder("processing-confirmed", {
      status: "confirmed",
      stockReservationStatus: "committed",
      supplierId: supplierA,
      supplierIds: [supplierA],
    });
    const accepted = await transition(confirmed, "accepted", 1, 1);
    const processing = await transition(confirmed, "processing", accepted.groupRevision, accepted.orderPrivateRevision);
    assert.equal(processing.status, "processing");
  });

  await t.test("expiry cancels and restores an untouched pending reservation exactly once", async () => {
    const fixture = await seedOrder("expiry-safe");
    const outcomes = await Promise.all([
      expireReservation(fixture.orderReference, adminDb),
      expireReservation(fixture.orderReference, adminDb),
    ]);
    assert.deepEqual(outcomes.sort(), [false, true]);
    const state = await readState(fixture.orderId, fixture.productId);
    assert.equal(state.order.status, "cancelled");
    assert.equal(state.order.stockReservationStatus, "released");
    assert.equal(state.order.stockRestorationApplied, true);
    assert.equal(state.product.stock, 10);
  });

  await t.test("expiry fails closed for assigned or started legacy pending reservations", async () => {
    const assigned = await seedOrder("expiry-assigned", {
      supplierId: supplierA,
      supplierIds: [supplierA],
    });
    assert.equal(await expireReservation(assigned.orderReference, adminDb), false);
    let state = await readState(assigned.orderId, assigned.productId);
    assert.equal(state.order.status, "pending");
    assert.equal(state.order.stockReservationStatus, "reserved");
    assert.equal(state.product.stock, 8);

    const started = await seedOrder("expiry-started", { supplierFulfilmentStatus: "processing" });
    assert.equal(await expireReservation(started.orderReference, adminDb), false);
    state = await readState(started.orderId, started.productId);
    assert.equal(state.order.status, "pending");
    assert.equal(state.order.stockRestorationApplied, false);
    assert.equal(state.product.stock, 8);
  });

  await t.test("Admin cancellation restores before fulfilment but is rejected after it starts", async () => {
    const safe = await seedOrder("cancel-safe", {
      status: "confirmed",
      stockReservationStatus: "committed",
      supplierId: supplierA,
      supplierIds: [supplierA],
    });
    const result = await updateOrderStatus(safe.orderId, "cancelled", undefined, adminDb);
    assert.deepEqual(result, { status: "cancelled", stockRestored: true });
    let state = await readState(safe.orderId, safe.productId);
    assert.equal(state.product.stock, 10);

    const started = await seedOrder("cancel-started", {
      status: "processing",
      stockReservationStatus: "committed",
      supplierId: supplierA,
      supplierIds: [supplierA],
      supplierFulfilmentStatus: "processing",
    });
    await assert.rejects(
      updateOrderStatus(started.orderId, "cancelled", undefined, adminDb),
      /cannot be cancelled after supplier fulfilment has started/i,
    );
    state = await readState(started.orderId, started.productId);
    assert.equal(state.order.status, "processing");
    assert.equal(state.product.stock, 8);
  });

  await t.test("cancelled orders cannot continue fulfilment and started orders cannot be reassigned", async () => {
    const cancelled = await seedOrder("cancelled-progression", {
      status: "cancelled",
      stockReservationStatus: "released",
      stockRestorationApplied: true,
      supplierId: supplierA,
      supplierIds: [supplierA],
    });
    await assert.rejects(
      transition(cancelled, "accepted", 1, 1),
      /confirmed active order/i,
    );

    const started = await seedOrder("reassignment-started", {
      status: "processing",
      stockReservationStatus: "committed",
      supplierId: supplierA,
      supplierIds: [supplierA],
      supplierFulfilmentStatus: "processing",
    });
    await assert.rejects(assign(started), /after supplier acceptance/i);
    assert.equal((await started.orderReference.get()).data()?.supplierAssignmentActive, true);
  });

  await t.test("concurrent assignment versus expiry cannot create assigned cancelled stock", async () => {
    const fixture = await seedOrder("race-assignment-expiry");
    const results = await Promise.allSettled([
      assign(fixture),
      expireReservation(fixture.orderReference, adminDb),
    ]);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const state = await readState(fixture.orderId, fixture.productId);
    assert.equal(state.order.status, "cancelled");
    assert.equal(state.order.supplierId, undefined);
    assert.equal(state.product.stock, 10);
  });

  await t.test("concurrent processing versus expiry fails closed for an unsafe legacy assignment", async () => {
    const fixture = await seedOrder("race-processing-expiry", {
      supplierId: supplierA,
      supplierIds: [supplierA],
    });
    const [processing, expiry] = await Promise.allSettled([
      transition(fixture, "accepted", 1, 1),
      expireReservation(fixture.orderReference, adminDb),
    ]);
    assert.equal(processing.status, "rejected");
    assert.equal(expiry.status, "fulfilled");
    assert.equal(expiry.status === "fulfilled" && expiry.value, false);
    const state = await readState(fixture.orderId, fixture.productId);
    assert.equal(state.order.status, "pending");
    assert.equal(state.order.supplierFulfilmentStatus, "pending");
    assert.equal(state.product.stock, 8);
  });

  await t.test("concurrent processing versus cancellation has only one safe winner", async () => {
    const fixture = await seedOrder("race-processing-cancel", {
      status: "confirmed",
      stockReservationStatus: "committed",
      supplierId: supplierA,
      supplierIds: [supplierA],
      supplierFulfilmentStatus: "accepted",
    });
    const results = await Promise.allSettled([
      transition(fixture, "processing", 1, 1),
      updateOrderStatus(fixture.orderId, "cancelled", undefined, adminDb),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const state = await readState(fixture.orderId, fixture.productId);
    if (state.order.status === "cancelled") {
      assert.equal(state.order.supplierFulfilmentStatus, "pending");
      assert.equal(state.order.stockRestorationApplied, true);
      assert.equal(state.product.stock, 10);
    } else {
      assert.equal(state.order.status, "processing");
      assert.equal(state.order.supplierFulfilmentStatus, "processing");
      assert.equal(state.order.stockRestorationApplied, false);
      assert.equal(state.product.stock, 8);
    }
  });

  await t.test("concurrent shipping versus cancellation cannot restore shipped inventory", async () => {
    const fixture = await seedOrder("race-shipping-cancel", {
      status: "processing",
      stockReservationStatus: "committed",
      supplierId: supplierA,
      supplierIds: [supplierA],
      supplierFulfilmentStatus: "packed",
    });
    const results = await Promise.allSettled([
      transition(fixture, "shipped", 1, 1),
      updateOrderStatus(fixture.orderId, "cancelled", undefined, adminDb),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const state = await readState(fixture.orderId, fixture.productId);
    assert.equal(state.order.status, "shipped");
    assert.equal(state.order.supplierFulfilmentStatus, "shipped");
    assert.equal(state.order.stockRestorationApplied, false);
    assert.equal(state.product.stock, 8);
  });
});
