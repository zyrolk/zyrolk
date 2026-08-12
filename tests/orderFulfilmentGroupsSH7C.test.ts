import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { adminAuth, adminDb } from "../functions/src/api/firebase";
import {
  assignOrderFulfilmentGroup,
  parseOrderPrivateFulfilment,
  recordOrderFulfilmentTracking,
  transitionOrderFulfilmentGroup,
} from "../functions/src/api/orders/orderFulfilmentGroups";
import {
  buildOrderPrivateDocument,
  type OrderPrivateAttributionLine,
} from "../functions/src/api/orders/orderPrivateAttribution";
import { updateOrderStatus } from "../functions/src/api/routes/orders";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRun = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));
const prefix = "sh7c-fulfilment-groups";
const adminUid = `${prefix}-admin`;
const supplierA = `${prefix}-supplier-a`;
const supplierB = `${prefix}-supplier-b`;
const wrongSupplier = `${prefix}-supplier-wrong`;

interface Fixture {
  orderId: string;
  productIds: string[];
  groupIds: Record<string, string>;
}

const sourceId = (scenario: string, accountId: string, suffix = "source") => `${prefix}-${scenario}-${accountId}-${suffix}`;

const seedSupplier = async (accountId: string, active = true): Promise<void> => {
  await Promise.all([
    adminDb.collection("users").doc(accountId).set({ role: "supplier", email: `${accountId}@example.test` }),
    adminDb.collection("supplier_profiles").doc(accountId).set({
      supplierId: accountId,
      companyName: accountId,
      profileStatus: active ? "active" : "disabled",
    }),
  ]);
};

const privateLine = (
  scenario: string,
  lineNumber: number,
  accountId: string | null,
  source: string | null,
  fulfilmentMode: "supplier" | "internal" = "supplier",
): OrderPrivateAttributionLine => {
  const productId = `${prefix}-${scenario}-product-${lineNumber}`;
  const capturedAt = "2026-08-10T00:00:00.000Z";
  return {
    lineId: `${prefix}-${scenario}-line-${lineNumber}`,
    productId,
    zyroSku: `ZY-SH7C-${scenario.toUpperCase()}-${lineNumber}`,
    fulfilmentMode,
    supplierOfferId: accountId ? `${prefix}-${scenario}-offer-${lineNumber}` : null,
    supplierOfferStateVersion: accountId ? 7 : null,
    supplierSourceId: source,
    supplierId: accountId ? `${prefix}-${scenario}-catalog-${accountId}` : null,
    supplierAccountId: accountId,
    supplierProductId: accountId ? `${prefix}-${scenario}-supplier-product-${lineNumber}` : null,
    supplierItemCode: accountId ? `SUP-${scenario.toUpperCase()}-${lineNumber}` : null,
    purchaseSupplierCost: accountId ? 700 + lineNumber : null,
    approvedOfferPrice: accountId ? 1_000 + lineNumber : null,
    approvedOfferStockEvidence: accountId ? 20 : null,
    capturedAt,
  };
};

const seedOrder = async (
  scenario: string,
  lineOwners: Array<{ accountId: string | null; sourceSuffix?: string; mode?: "supplier" | "internal" }>,
  status = "confirmed",
): Promise<Fixture> => {
  const orderId = `${prefix}-${scenario}-order`;
  const lines = lineOwners.map((owner, index) => privateLine(
    scenario,
    index + 1,
    owner.accountId,
    owner.accountId ? sourceId(scenario, owner.accountId, owner.sourceSuffix) : null,
    owner.mode || "supplier",
  ));
  const privateOrder = buildOrderPrivateDocument(orderId, lines, lines[0]?.capturedAt || "2026-08-10T00:00:00.000Z");
  const productIds = lines.map((line) => line.productId);
  const groupIds = Object.fromEntries(privateOrder.fulfilmentGroups.map((group) => [group.supplierAccountId, group.groupId]));
  const uniqueSources = new Map<string, string>();
  lines.filter((line) => line.fulfilmentMode === "supplier").forEach((line) => uniqueSources.set(line.supplierSourceId!, line.supplierAccountId!));
  await Promise.all([
    ...productIds.map((productId, index) => adminDb.collection("products").doc(productId).set({
      id: productId,
      name: `SH-7C ${scenario} ${index + 1}`,
      price: 1_500 + index,
      stock: 8,
      isActive: true,
    })),
    ...[...uniqueSources].map(([id, accountId]) => adminDb.collection("supplierSources").doc(id).set({
      supplierId: `${prefix}-${scenario}-catalog-${accountId}`,
      supplierAccountId: accountId,
      supplierName: id,
      connectorType: "http",
      sourceStatus: "active",
      enabled: true,
      authentication: { mode: "none" },
    })),
    adminDb.collection("orders").doc(orderId).set({
      orderNumber: `SH7C-${scenario.toUpperCase()}`,
      customerUid: `${prefix}-customer`,
      customerName: "SH-7C Customer",
      customerEmail: "customer@example.test",
      customerPhone: "0771000000",
      customerAddress: "1 Emulator Road",
      status,
      paymentMethod: "cod",
      paymentStatus: "not_required",
      stockDeducted: true,
      stockReservationStatus: "committed",
      stockRestorationApplied: false,
      supplierAssignmentActive: false,
      supplierFulfilmentStatus: "pending",
      items: lines.map((line, index) => ({
        productId: line.productId,
        name: `SH-7C ${scenario} ${index + 1}`,
        price: 1_500 + index,
        quantity: 1,
        image: "https://cdn.example.test/sh7c.jpg",
      })),
      subtotal: lines.length * 1_500,
      total: lines.length * 1_500,
      createdAt: new Date().toISOString(),
    }),
    adminDb.collection("order_private").doc(orderId).set(privateOrder),
  ]);
  return { orderId, productIds, groupIds };
};

const readPrivate = async (orderId: string) => {
  const snapshot = await adminDb.collection("order_private").doc(orderId).get();
  assert.equal(snapshot.exists, true);
  return parseOrderPrivateFulfilment(orderId, snapshot.data());
};

const groupFor = async (fixture: Fixture, accountId: string) => {
  const privateOrder = await readPrivate(fixture.orderId);
  const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.supplierAccountId === accountId);
  assert.ok(group);
  return { privateOrder, group };
};

const assign = async (fixture: Fixture, accountId: string) => {
  const { privateOrder, group } = await groupFor(fixture, accountId);
  return assignOrderFulfilmentGroup({
    db: adminDb,
    orderId: fixture.orderId,
    groupId: group.groupId,
    supplierAccountId: accountId,
    expectedGroupRevision: group.revision,
    expectedOrderPrivateRevision: privateOrder.revision,
    adminUid,
  });
};

const transition = async (fixture: Fixture, accountId: string, status: string, reason?: string) => {
  const { privateOrder, group } = await groupFor(fixture, accountId);
  return transitionOrderFulfilmentGroup({
    db: adminDb,
    orderId: fixture.orderId,
    groupId: group.groupId,
    supplierAccountId: accountId,
    nextStatus: status,
    expectedGroupRevision: group.revision,
    expectedOrderPrivateRevision: privateOrder.revision,
    reason,
  });
};

const ship = async (fixture: Fixture, accountId: string) => {
  const { privateOrder, group } = await groupFor(fixture, accountId);
  return recordOrderFulfilmentTracking({
    db: adminDb,
    orderId: fixture.orderId,
    groupId: group.groupId,
    supplierAccountId: accountId,
    expectedGroupRevision: group.revision,
    expectedOrderPrivateRevision: privateOrder.revision,
    courierName: "SH-7C Test Courier",
    trackingNumber: `SH7C-${fixture.orderId}-${accountId}`,
  });
};

const progressTo = async (fixture: Fixture, accountId: string, target: "accepted" | "processing" | "packed" | "shipped") => {
  const ordered = ["accepted", "processing", "packed"] as const;
  const current = (await groupFor(fixture, accountId)).group.status;
  const currentIndex = ordered.indexOf(current as typeof ordered[number]);
  const targetIndex = target === "shipped" ? ordered.length - 1 : ordered.indexOf(target);
  for (const state of ordered.slice(currentIndex + 1, targetIndex + 1)) {
    await transition(fixture, accountId, state);
  }
  if (target === "shipped") await ship(fixture, accountId);
};

const ensureAuthUser = async (uid: string, email: string, password: string, claims: Record<string, unknown> = {}) => {
  try {
    await adminAuth.getUser(uid);
    await adminAuth.updateUser(uid, { email, password, disabled: false });
  } catch {
    await adminAuth.createUser({ uid, email, password });
  }
  await adminAuth.setCustomUserClaims(uid, claims);
};

test("SH-7C groups immutable lines and routes supplier fulfilment transactionally", {
  skip: canRun ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 300_000,
}, async (t) => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(authHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);
  await Promise.all([seedSupplier(supplierA), seedSupplier(supplierB), seedSupplier(wrongSupplier)]);

  await t.test("checkout contract creates deterministic groups per supplier account", async () => {
    const fixture = await seedOrder("construction", [
      { accountId: supplierA, sourceSuffix: "one" },
      { accountId: supplierA, sourceSuffix: "two" },
      { accountId: supplierB },
      { accountId: null, mode: "internal" },
    ]);
    const privateOrder = await readPrivate(fixture.orderId);
    assert.equal(privateOrder.fulfilmentGroups.length, 2);
    assert.deepEqual(privateOrder.fulfilmentGroups.map((group) => group.supplierAccountId), [supplierA, supplierB]);
    assert.equal(privateOrder.fulfilmentGroups.find((group) => group.supplierAccountId === supplierA)?.lineIds.length, 2);
    assert.equal(privateOrder.fulfilmentGroups.find((group) => group.supplierAccountId === supplierA)?.supplierSourceIds.length, 2);
    assert.equal(privateOrder.lines.filter((line) => line.fulfilmentMode === "internal").length, 1);
    assert.equal(new Set(privateOrder.fulfilmentGroups.map((group) => group.groupId)).size, 2);
  });

  await t.test("assignment validates purchase ownership, active account and current source mapping", async () => {
    const pending = await seedOrder("assignment-pending", [{ accountId: supplierA }], "pending");
    await adminDb.collection("orders").doc(pending.orderId).set({ stockReservationStatus: "reserved" }, { merge: true });
    await assert.rejects(assign(pending, supplierA), /confirmed active order/i);

    const reserved = await seedOrder("assignment-reserved", [{ accountId: supplierA }]);
    await adminDb.collection("orders").doc(reserved.orderId).set({ stockReservationStatus: "reserved" }, { merge: true });
    await assert.rejects(assign(reserved, supplierA), /committed inventory/i);

    const wrong = await seedOrder("assignment-wrong", [{ accountId: supplierA }]);
    const { privateOrder, group } = await groupFor(wrong, supplierA);
    await assert.rejects(assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: wrong.orderId,
      groupId: group.groupId,
      supplierAccountId: wrongSupplier,
      expectedGroupRevision: group.revision,
      expectedOrderPrivateRevision: privateOrder.revision,
      adminUid,
    }), /not authorized for every line/i);

    const inactive = `${prefix}-inactive`;
    await seedSupplier(inactive, false);
    const inactiveFixture = await seedOrder("assignment-inactive", [{ accountId: inactive }]);
    await assert.rejects(assign(inactiveFixture, inactive), /profile is not active/i);

    const missing = await seedOrder("assignment-missing-source", [{ accountId: supplierA }]);
    const missingPrivate = await readPrivate(missing.orderId);
    await adminDb.collection("supplierSources").doc(missingPrivate.fulfilmentGroups[0].supplierSourceIds[0]).delete();
    await assert.rejects(assign(missing, supplierA), /routing is no longer available/i);

    const mismatch = await seedOrder("assignment-mismatch", [{ accountId: supplierA }]);
    const mismatchPrivate = await readPrivate(mismatch.orderId);
    await adminDb.collection("supplierSources").doc(mismatchPrivate.fulfilmentGroups[0].supplierSourceIds[0]).set({ supplierAccountId: supplierB }, { merge: true });
    await assert.rejects(assign(mismatch, supplierA), /routing no longer matches/i);
  });

  await t.test("legal transitions, decline/reassignment, immutable revisions and stale actions fail closed", async () => {
    const fixture = await seedOrder("lifecycle", [{ accountId: supplierA }]);
    const assigned = await assign(fixture, supplierA);
    assert.equal(assigned.status, "assigned");
    assert.equal(assigned.groupRevision, 2);
    assert.equal(assigned.orderPrivateRevision, 2);
    await assert.rejects(transition(fixture, supplierA, "processing"), /cannot move from assigned to processing/i);

    const declined = await transition(fixture, supplierA, "unassigned", "Capacity unavailable");
    assert.equal(declined.status, "unassigned");
    assert.equal((await groupFor(fixture, supplierA)).group.declineReason, "Capacity unavailable");
    await assign(fixture, supplierA);
    await progressTo(fixture, supplierA, "accepted");
    await assert.rejects(transition(fixture, supplierA, "unassigned"), /cannot move from accepted to unassigned/i);
    await assert.rejects(assign(fixture, supplierA), /after supplier acceptance/i);
    await progressTo(fixture, supplierA, "shipped");
    await assert.rejects(transition(fixture, supplierA, "delivered"), /status is invalid/i);

    const stale = await seedOrder("stale", [{ accountId: supplierA }]);
    const before = await groupFor(stale, supplierA);
    await assign(stale, supplierA);
    await assert.rejects(assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: stale.orderId,
      groupId: before.group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: before.group.revision,
      expectedOrderPrivateRevision: before.privateOrder.revision,
      adminUid,
    }), /state changed/i);

    const reassignmentAudits = await adminDb.collection("supplier_operations_audit")
      .where("orderId", "==", fixture.orderId).get();
    assert.equal(reassignmentAudits.docs.some((document) => document.data().action === "reassigned"), true);
  });

  await t.test("supplier ownership, terminal order fences, immutable attribution and transition idempotency hold", async () => {
    const fixture = await seedOrder("ownership", [{ accountId: supplierA }]);
    const immutableBefore = (await adminDb.collection("order_private").doc(fixture.orderId).get()).data()?.lines;
    await assign(fixture, supplierA);
    const assignedState = await groupFor(fixture, supplierA);
    await assert.rejects(transitionOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: assignedState.group.groupId,
      supplierAccountId: wrongSupplier,
      nextStatus: "accepted",
      expectedGroupRevision: assignedState.group.revision,
      expectedOrderPrivateRevision: assignedState.privateOrder.revision,
    }), /assigned fulfilment group not found/i);

    const transitionResults = await Promise.allSettled([1, 2].map(() => transitionOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: assignedState.group.groupId,
      supplierAccountId: supplierA,
      nextStatus: "accepted",
      expectedGroupRevision: assignedState.group.revision,
      expectedOrderPrivateRevision: assignedState.privateOrder.revision,
    })));
    assert.equal(transitionResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(transitionResults.filter((result) => result.status === "rejected").length, 1);
    const current = await groupFor(fixture, supplierA);
    const idempotent = await transitionOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: current.group.groupId,
      supplierAccountId: supplierA,
      nextStatus: "accepted",
      expectedGroupRevision: current.group.revision,
      expectedOrderPrivateRevision: current.privateOrder.revision,
    });
    assert.equal(idempotent.groupRevision, current.group.revision);
    const acceptanceAudits = await adminDb.collection("supplier_operations_audit")
      .where("orderId", "==", fixture.orderId).get();
    assert.equal(acceptanceAudits.docs.filter((document) => document.data().action === "accepted").length, 1);

    const source = current.group.supplierSourceIds[0];
    await adminDb.collection("supplierSources").doc(source).set({ supplierAccountId: supplierB }, { merge: true });
    assert.deepEqual((await adminDb.collection("order_private").doc(fixture.orderId).get()).data()?.lines, immutableBefore);

    for (const terminalStatus of ["cancelled", "delivered"]) {
      const terminal = await seedOrder(`terminal-${terminalStatus}`, [{ accountId: supplierA }]);
      await assign(terminal, supplierA);
      await adminDb.collection("orders").doc(terminal.orderId).set({ status: terminalStatus }, { merge: true });
      await assert.rejects(transition(terminal, supplierA, "accepted"), /confirmed active order/i);
    }
  });

  await t.test("aggregate order status reflects partial and complete multi-supplier progress", async () => {
    const fixture = await seedOrder("aggregate", [{ accountId: supplierA }, { accountId: supplierB }]);
    await assign(fixture, supplierA);
    await assign(fixture, supplierB);
    await progressTo(fixture, supplierA, "accepted");
    assert.equal((await adminDb.collection("orders").doc(fixture.orderId).get()).data()?.status, "processing");
    await progressTo(fixture, supplierA, "shipped");
    await progressTo(fixture, supplierB, "processing");
    assert.equal((await adminDb.collection("orders").doc(fixture.orderId).get()).data()?.status, "processing");
    await progressTo(fixture, supplierB, "packed");
    assert.equal((await adminDb.collection("orders").doc(fixture.orderId).get()).data()?.status, "packed");
    await progressTo(fixture, supplierB, "shipped");
    assert.equal((await adminDb.collection("orders").doc(fixture.orderId).get()).data()?.status, "shipped");

    const beforeDelivery = await readPrivate(fixture.orderId);
    const revisions = Object.fromEntries(beforeDelivery.fulfilmentGroups.map((group) => [group.groupId, group.revision]));
    const delivery = await updateOrderStatus(fixture.orderId, "delivered", undefined, adminDb, {
      adminUid,
      expectedOrderPrivateRevision: beforeDelivery.revision,
      expectedGroupRevisions: revisions,
    });
    assert.equal(delivery.status, "delivered");
    assert.equal((await readPrivate(fixture.orderId)).fulfilmentGroups.every((group) => group.status === "delivered"), true);

    const premature = await seedOrder("delivery-premature", [{ accountId: supplierA }, { accountId: supplierB }]);
    await assign(premature, supplierA);
    await assign(premature, supplierB);
    await progressTo(premature, supplierA, "shipped");
    const privateOrder = await readPrivate(premature.orderId);
    await assert.rejects(updateOrderStatus(premature.orderId, "delivered", undefined, adminDb, {
      adminUid,
      expectedOrderPrivateRevision: privateOrder.revision,
      expectedGroupRevisions: Object.fromEntries(privateOrder.fulfilmentGroups.map((group) => [group.groupId, group.revision])),
    }), /requires every supplier fulfilment group to be shipped/i);
  });

  await t.test("cancellation and concurrent mutations have one safe transactional winner", async () => {
    const cancellable = await seedOrder("cancel-assigned", [{ accountId: supplierA }]);
    await assign(cancellable, supplierA);
    const cancelled = await updateOrderStatus(cancellable.orderId, "cancelled", undefined, adminDb);
    assert.equal(cancelled.stockRestored, true);
    assert.equal((await adminDb.collection("products").doc(cancellable.productIds[0]).get()).data()?.stock, 9);
    await assert.rejects(transition(cancellable, supplierA, "accepted"), /confirmed active order/i);

    const started = await seedOrder("cancel-started", [{ accountId: supplierA }]);
    await assign(started, supplierA);
    await progressTo(started, supplierA, "accepted");
    await assert.rejects(updateOrderStatus(started.orderId, "cancelled", undefined, adminDb), /after supplier fulfilment has started/i);

    const assignmentRace = await seedOrder("race-assignment", [{ accountId: supplierA }]);
    const raceBefore = await groupFor(assignmentRace, supplierA);
    const assignmentResults = await Promise.allSettled([1, 2].map(() => assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: assignmentRace.orderId,
      groupId: raceBefore.group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: raceBefore.group.revision,
      expectedOrderPrivateRevision: raceBefore.privateOrder.revision,
      adminUid,
    })));
    assert.equal(assignmentResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(assignmentResults.filter((result) => result.status === "rejected").length, 1);

    const cancellationRace = await seedOrder("race-cancel", [{ accountId: supplierA }]);
    await assign(cancellationRace, supplierA);
    const raceState = await groupFor(cancellationRace, supplierA);
    const mutationResults = await Promise.allSettled([
      transitionOrderFulfilmentGroup({
        db: adminDb,
        orderId: cancellationRace.orderId,
        groupId: raceState.group.groupId,
        supplierAccountId: supplierA,
        nextStatus: "accepted",
        expectedGroupRevision: raceState.group.revision,
        expectedOrderPrivateRevision: raceState.privateOrder.revision,
      }),
      updateOrderStatus(cancellationRace.orderId, "cancelled", undefined, adminDb),
    ]);
    assert.equal(mutationResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(mutationResults.filter((result) => result.status === "rejected").length, 1);
    const publicState = (await adminDb.collection("orders").doc(cancellationRace.orderId).get()).data()!;
    assert.equal(["cancelled", "processing"].includes(publicState.status), true);
    assert.equal(publicState.status === "cancelled" ? publicState.stockRestorationApplied : !publicState.stockRestorationApplied, true);

    const shippingRace = await seedOrder("race-shipping", [{ accountId: supplierA }]);
    await assign(shippingRace, supplierA);
    await progressTo(shippingRace, supplierA, "packed");
    const shippingResults = await Promise.allSettled([
      ship(shippingRace, supplierA),
      updateOrderStatus(shippingRace.orderId, "cancelled", undefined, adminDb),
    ]);
    assert.equal(shippingResults[0].status, "fulfilled");
    assert.equal(shippingResults[1].status, "rejected");
  });

  await t.test("real HTTP Admin assignment and Supplier Portal projection isolate each group", async () => {
    const fixture = await seedOrder("http", [{ accountId: supplierA }, { accountId: supplierB }]);
    const password = "SH7C-Emulator-Password!";
    const adminEmail = `${adminUid}@example.test`;
    const supplierAEmail = `${supplierA}@example.test`;
    const supplierBEmail = `${supplierB}@example.test`;
    await Promise.all([
      ensureAuthUser(adminUid, adminEmail, password, { admin: true }),
      ensureAuthUser(supplierA, supplierAEmail, password, { role: "supplier" }),
      ensureAuthUser(supplierB, supplierBEmail, password, { role: "supplier" }),
    ]);
    const app = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-http-client`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    const apiBase = `http://${functionsHost}/${projectId}/us-central1/api`;
    try {
      const adminUser = await signInWithEmailAndPassword(auth, adminEmail, password);
      const adminToken = await adminUser.user.getIdToken(true);
      const groupA = await groupFor(fixture, supplierA);
      const assignmentResponse = await fetch(`${apiBase}/api/supplier-portal/orders/${fixture.orderId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          groupId: groupA.group.groupId,
          supplierId: supplierA,
          expectedGroupRevision: groupA.group.revision,
          expectedOrderPrivateRevision: groupA.privateOrder.revision,
        }),
      });
      assert.equal(assignmentResponse.status, 200, await assignmentResponse.clone().text());

      const supplierAUser = await signInWithEmailAndPassword(auth, supplierAEmail, password);
      const supplierAToken = await supplierAUser.user.getIdToken(true);
      const portalResponse = await fetch(`${apiBase}/api/supplier-portal?pageSize=100`, {
        headers: { Authorization: `Bearer ${supplierAToken}` },
      });
      assert.equal(portalResponse.status, 200, await portalResponse.clone().text());
      const portal = await portalResponse.json() as { orders: Array<Record<string, unknown>> };
      const routedOrder = portal.orders.find((order) => order.id === fixture.orderId);
      assert.ok(routedOrder);
      assert.equal(routedOrder.attributionAvailable, true);
      assert.equal(routedOrder.groupId, fixture.groupIds[supplierA]);
      assert.equal((routedOrder.items as Array<unknown>).length, 1);
      const projection = JSON.stringify(routedOrder);
      for (const privateName of ["purchaseSupplierCost", "supplierOfferId", "supplierSourceId", "supplierAccountId", "supplierItemCode"]) {
        assert.doesNotMatch(projection, new RegExp(privateName, "u"));
      }

      const acceptResponse = await fetch(`${apiBase}/api/supplier-portal/orders/${fixture.orderId}/groups/${routedOrder.groupId}/fulfilment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${supplierAToken}` },
        body: JSON.stringify({
          status: "accepted",
          expectedGroupRevision: routedOrder.groupRevision,
          expectedOrderPrivateRevision: routedOrder.orderPrivateRevision,
        }),
      });
      assert.equal(acceptResponse.status, 200, await acceptResponse.clone().text());

      const supplierBUser = await signInWithEmailAndPassword(auth, supplierBEmail, password);
      const supplierBToken = await supplierBUser.user.getIdToken(true);
      const isolatedResponse = await fetch(`${apiBase}/api/supplier-portal?pageSize=100`, {
        headers: { Authorization: `Bearer ${supplierBToken}` },
      });
      const isolatedPortal = await isolatedResponse.json() as { orders: Array<Record<string, unknown>> };
      assert.equal(isolatedPortal.orders.some((order) => order.id === fixture.orderId), false);
    } finally {
      await deleteApp(app);
    }
  });

  await t.test("Rules, public projection, audit privacy and legacy orders remain fail closed", async () => {
    const fixture = await seedOrder("rules-audit", [{ accountId: supplierA }]);
    await assign(fixture, supplierA);
    await progressTo(fixture, supplierA, "accepted");
    const publicOrder = (await adminDb.collection("orders").doc(fixture.orderId).get()).data()!;
    const publicJson = JSON.stringify(publicOrder);
    assert.equal(publicOrder.supplierAssignmentActive, true);
    for (const privateName of ["supplierAccountId", "supplierSourceId", "supplierOfferId", "supplierItemCode", "purchaseSupplierCost"]) {
      assert.doesNotMatch(publicJson, new RegExp(privateName, "u"));
    }
    const audits = await adminDb.collection("supplier_operations_audit").where("orderId", "==", fixture.orderId).get();
    assert.equal(audits.size, 2);
    const auditJson = JSON.stringify(audits.docs.map((document) => document.data()));
    assert.doesNotMatch(auditJson, /purchaseSupplierCost|customerEmail|customerPhone|customerAddress/u);

    const [host, portText] = firestoreHost!.split(":");
    const rulesEnvironment = await initializeTestEnvironment({
      projectId: projectId!,
      firestore: { host, port: Number(portText), rules: readFileSync("firestore.rules", "utf8") },
    });
    try {
      const customerDb = rulesEnvironment.authenticatedContext(`${prefix}-customer`).firestore();
      const supplierDb = rulesEnvironment.authenticatedContext(supplierA, { role: "supplier" }).firestore();
      await assertSucceeds(getDoc(doc(customerDb, "orders", fixture.orderId)));
      await assertFails(getDoc(doc(customerDb, "order_private", fixture.orderId)));
      await assertFails(setDoc(doc(customerDb, "order_private", fixture.orderId), { revision: 99 }));
      await assertFails(deleteDoc(doc(customerDb, "order_private", fixture.orderId)));
      await assertFails(getDoc(doc(supplierDb, "order_private", fixture.orderId)));
      await assertFails(setDoc(doc(supplierDb, "orders", fixture.orderId), { status: "shipped" }, { merge: true }));
    } finally {
      await rulesEnvironment.cleanup();
    }

    const legacyOrderId = `${prefix}-legacy-order`;
    await adminDb.collection("orders").doc(legacyOrderId).set({
      orderNumber: "SH7C-LEGACY",
      status: "confirmed",
      stockReservationStatus: "committed",
      stockRestorationApplied: false,
      items: [],
    });
    await assert.rejects(assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: legacyOrderId,
      groupId: "legacy-group",
      supplierAccountId: supplierA,
      expectedGroupRevision: 1,
      expectedOrderPrivateRevision: 1,
      adminUid,
    }), /legacy order/i);
  });
});
