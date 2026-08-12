import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { adminAuth, adminDb } from "../functions/src/api/firebase";
import {
  correctOrderFulfilmentTracking,
  deriveOrderStatusFromFulfilmentGroups,
  parseOrderPrivateFulfilment,
  recordOrderFulfilmentTracking,
  validateTrackingInput,
} from "../functions/src/api/orders/orderFulfilmentGroups";
import {
  buildOrderPrivateDocument,
  type OrderPrivateAttributionLine,
} from "../functions/src/api/orders/orderPrivateAttribution";
import { updateOrderStatus } from "../functions/src/api/routes/orders";
import { verifySupplierPortalIdentityToken } from "../functions/src/api/routes/supplierPortal";
import { normalizeCustomerOrder } from "../src/features/account/customerOrders";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRun = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));
const prefix = "sh7d-tracking";
const adminUid = `${prefix}-admin`;
const customerUid = `${prefix}-customer`;
const supplierA = `${prefix}-supplier-a`;
const supplierB = `${prefix}-supplier-b`;
const wrongSupplier = `${prefix}-supplier-wrong`;
const timestamp = "2026-08-11T00:00:00.000Z";

interface Fixture {
  orderId: string;
  groupIds: Record<string, string>;
  productIds: string[];
  offerIds: string[];
}

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

const makeLine = (scenario: string, index: number, accountId: string): OrderPrivateAttributionLine => ({
  lineId: `${prefix}-${scenario}-line-${index}`,
  productId: `${prefix}-${scenario}-product-${index}`,
  zyroSku: `ZY-SH7D-${scenario.toUpperCase()}-${index}`,
  fulfilmentMode: "supplier",
  supplierOfferId: `${prefix}-${scenario}-offer-${index}`,
  supplierOfferStateVersion: 11,
  supplierSourceId: `${prefix}-${scenario}-${accountId}-source`,
  supplierId: `${prefix}-${scenario}-${accountId}-catalog`,
  supplierAccountId: accountId,
  supplierProductId: `${prefix}-${scenario}-supplier-product-${index}`,
  supplierItemCode: `SUP-${scenario.toUpperCase()}-${index}`,
  purchaseSupplierCost: 700 + index,
  approvedOfferPrice: 1_000 + index,
  approvedOfferStockEvidence: 20,
  capturedAt: timestamp,
});

const setGroupStatus = (
  group: ReturnType<typeof buildOrderPrivateDocument>["fulfilmentGroups"][number],
  status: typeof group.status,
) => ({
  ...group,
  status,
  assignedAt: status === "unassigned" ? null : timestamp,
  assignedBy: status === "unassigned" ? null : adminUid,
  acceptedAt: ["accepted", "processing", "packed", "shipped", "delivered"].includes(status) ? timestamp : null,
  processingAt: ["processing", "packed", "shipped", "delivered"].includes(status) ? timestamp : null,
  packedAt: ["packed", "shipped", "delivered"].includes(status) ? timestamp : null,
  shippedAt: ["shipped", "delivered"].includes(status) ? timestamp : null,
  deliveredAt: status === "delivered" ? timestamp : null,
});

const seedOrder = async (
  scenario: string,
  groups: Array<{ accountId: string; status: "unassigned" | "assigned" | "accepted" | "processing" | "packed" | "shipped" | "delivered" }>,
): Promise<Fixture> => {
  const orderId = `${prefix}-${scenario}-order`;
  const lines = groups.map((group, index) => makeLine(scenario, index + 1, group.accountId));
  const privateOrder = buildOrderPrivateDocument(orderId, lines, timestamp);
  privateOrder.fulfilmentGroups = privateOrder.fulfilmentGroups.map((group) => {
    const desired = groups.find((entry) => entry.accountId === group.supplierAccountId)?.status || "unassigned";
    return setGroupStatus(group, desired);
  });
  privateOrder.assignedSupplierAccountIds = privateOrder.fulfilmentGroups
    .filter((group) => group.status !== "unassigned")
    .map((group) => group.supplierAccountId)
    .sort();
  const publicStatus = deriveOrderStatusFromFulfilmentGroups(privateOrder.fulfilmentGroups);
  const uniqueAccounts = [...new Set(groups.map((group) => group.accountId))];
  await Promise.all([
    ...uniqueAccounts.map((accountId) => seedSupplier(accountId)),
    ...lines.map((line) => adminDb.collection("products").doc(line.productId).set({
      id: line.productId,
      name: `SH-7D ${scenario}`,
      price: 1_500,
      stock: 8,
      isActive: true,
    })),
    ...lines.map((line) => adminDb.collection("supplier_product_offers").doc(line.supplierOfferId!).set({
      id: line.supplierOfferId,
      stock: 20,
      stateVersion: 11,
      reviewStatus: "approved",
    })),
    adminDb.collection("orders").doc(orderId).set({
      orderNumber: `SH7D-${scenario.toUpperCase()}`,
      customerUid,
      customerName: "SH-7D Customer",
      customerEmail: "customer@example.test",
      customerPhone: "0771000000",
      customerAddress: "1 Emulator Road",
      district: "Colombo",
      city: "Colombo",
      status: publicStatus,
      paymentMethod: "cod",
      paymentStatus: "not_required",
      stockDeducted: true,
      stockReservationStatus: "committed",
      stockRestorationApplied: false,
      supplierAssignmentActive: privateOrder.assignedSupplierAccountIds.length > 0,
      supplierFulfilmentStatus: ["processing", "packed", "shipped", "delivered"].includes(publicStatus) ? publicStatus : "pending",
      items: lines.map((line) => ({
        productId: line.productId,
        name: `SH-7D ${scenario}`,
        price: 1_500,
        quantity: 1,
        imageUrl: "https://cdn.example.test/sh7d.jpg",
      })),
      totalPrice: lines.length * 1_500,
      createdAt: timestamp,
    }),
    adminDb.collection("order_private").doc(orderId).set(privateOrder),
  ]);
  return {
    orderId,
    groupIds: Object.fromEntries(privateOrder.fulfilmentGroups.map((group) => [group.supplierAccountId, group.groupId])),
    productIds: lines.map((line) => line.productId),
    offerIds: lines.map((line) => line.supplierOfferId!),
  };
};

const readPrivate = async (orderId: string) => {
  const snapshot = await adminDb.collection("order_private").doc(orderId).get();
  assert.equal(snapshot.exists, true);
  return parseOrderPrivateFulfilment(orderId, snapshot.data());
};

const trackingState = async (fixture: Fixture, accountId: string) => {
  const privateOrder = await readPrivate(fixture.orderId);
  const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.supplierAccountId === accountId);
  assert.ok(group);
  return { privateOrder, group };
};

const record = async (
  fixture: Fixture,
  accountId: string,
  values: { courierName?: unknown; trackingNumber?: unknown; trackingUrl?: unknown } = {},
) => {
  const { privateOrder, group } = await trackingState(fixture, accountId);
  return recordOrderFulfilmentTracking({
    db: adminDb,
    orderId: fixture.orderId,
    groupId: group.groupId,
    supplierAccountId: accountId,
    expectedGroupRevision: group.revision,
    expectedOrderPrivateRevision: privateOrder.revision,
    courierName: values.courierName ?? "Test Courier",
    trackingNumber: values.trackingNumber ?? `TRACK-${fixture.orderId}-${accountId}`,
    ...(Object.prototype.hasOwnProperty.call(values, "trackingUrl") ? { trackingUrl: values.trackingUrl } : {}),
  });
};

const ensureAuthUser = async (uid: string, email: string, password: string, claims: Record<string, unknown>) => {
  try {
    await adminAuth.getUser(uid);
    await adminAuth.updateUser(uid, { email, password, disabled: false });
  } catch {
    await adminAuth.createUser({ uid, email, password });
  }
  await adminAuth.setCustomUserClaims(uid, claims);
};

test("SH-7D records immutable manual tracking per fulfilment group", {
  skip: canRun ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 300_000,
}, async (t) => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(authHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);
  await Promise.all([seedSupplier(supplierA), seedSupplier(supplierB), seedSupplier(wrongSupplier)]);

  await t.test("tracking validation is bounded, rejects control characters and never accepts client URLs", () => {
    assert.throws(() => validateTrackingInput({ courierName: "", trackingNumber: "X" }), /courier name is required/i);
    assert.throws(() => validateTrackingInput({ courierName: "Courier", trackingNumber: "" }), /tracking number is required/i);
    assert.throws(() => validateTrackingInput({ courierName: "C".repeat(81), trackingNumber: "X" }), /courier name is too long/i);
    assert.throws(() => validateTrackingInput({ courierName: "Courier", trackingNumber: "X".repeat(121) }), /tracking number is too long/i);
    assert.throws(() => validateTrackingInput({ courierName: "Bad\u0000Courier", trackingNumber: "X" }), /control characters/i);
    assert.throws(() => validateTrackingInput({ courierName: "Courier", trackingNumber: "Bad\u0007Number" }), /control characters/i);
    assert.throws(() => validateTrackingInput({ courierName: "Courier", trackingNumber: "X", trackingUrl: "https://evil.example" }), /cannot be supplied/i);
    assert.deepEqual(validateTrackingInput({ courierName: " Unknown Courier ", trackingNumber: " LK 01-ABC " }), {
      courierName: "Unknown Courier",
      trackingNumber: "LK 01-ABC",
      trackingUrl: null,
    });
  });

  await t.test("a packed group records private tracking and a minimal customer-safe shipment atomically", async () => {
    const fixture = await seedOrder("record", [{ accountId: supplierA, status: "packed" }]);
    const beforePrivate = (await adminDb.collection("order_private").doc(fixture.orderId).get()).data()!;
    const beforeLines = beforePrivate.lines;
    const beforeProduct = (await adminDb.collection("products").doc(fixture.productIds[0]).get()).data()!;
    const beforeOffer = (await adminDb.collection("supplier_product_offers").doc(fixture.offerIds[0]).get()).data()!;
    const result = await record(fixture, supplierA, { courierName: "  Lanka Courier  ", trackingNumber: " LK-123 / A " });
    assert.equal(result.status, "shipped");
    assert.equal(result.tracking.courierName, "Lanka Courier");
    assert.equal(result.tracking.trackingNumber, "LK-123 / A");
    assert.equal(result.tracking.trackingUrl, null);
    assert.equal(result.tracking.revision, 1);
    const after = await trackingState(fixture, supplierA);
    assert.equal(after.group.status, "shipped");
    assert.equal(after.group.revision, 2);
    assert.equal(after.privateOrder.revision, 2);
    assert.deepEqual((await adminDb.collection("order_private").doc(fixture.orderId).get()).data()?.lines, beforeLines);
    const publicOrder = (await adminDb.collection("orders").doc(fixture.orderId).get()).data()!;
    assert.equal(publicOrder.status, "shipped");
    assert.equal(publicOrder.shipments.length, 1);
    assert.deepEqual(Object.keys(publicOrder.shipments[0]).sort(), [
      "courierName", "deliveredAt", "productIds", "shipmentId", "shippedAt", "status", "trackingNumber", "trackingUrl",
    ]);
    const publicJson = JSON.stringify(publicOrder);
    for (const privateField of ["supplierAccountId", "supplierSourceId", "supplierOfferId", "supplierItemCode", "purchaseSupplierCost"]) {
      assert.doesNotMatch(publicJson, new RegExp(privateField, "u"));
    }
    assert.equal((await adminDb.collection("products").doc(fixture.productIds[0]).get()).data()?.stock, beforeProduct.stock);
    assert.equal((await adminDb.collection("supplier_product_offers").doc(fixture.offerIds[0]).get()).data()?.stock, beforeOffer.stock);
    const audits = await adminDb.collection("supplier_operations_audit").where("orderId", "==", fixture.orderId).get();
    assert.equal(audits.docs.filter((entry) => entry.data().action === "tracking_recorded").length, 1);
    assert.doesNotMatch(JSON.stringify(audits.docs.map((entry) => entry.data())), /purchaseSupplierCost|customerEmail|customerPhone|customerAddress/u);
  });

  await t.test("ownership, active-account, lifecycle and terminal fences reject unsafe tracking", async () => {
    const wrong = await seedOrder("wrong-owner", [{ accountId: supplierA, status: "packed" }]);
    const state = await trackingState(wrong, supplierA);
    await assert.rejects(recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: wrong.orderId,
      groupId: state.group.groupId,
      supplierAccountId: wrongSupplier,
      expectedGroupRevision: state.group.revision,
      expectedOrderPrivateRevision: state.privateOrder.revision,
      courierName: "Courier",
      trackingNumber: "WRONG",
    }), /assigned fulfilment group not found/i);

    const inactive = `${prefix}-inactive`;
    const inactiveFixture = await seedOrder("inactive", [{ accountId: inactive, status: "packed" }]);
    await seedSupplier(inactive, false);
    await assert.rejects(record(inactiveFixture, inactive), /profile is not active/i);

    for (const status of ["unassigned", "assigned", "accepted", "processing", "shipped", "delivered"] as const) {
      const fixture = await seedOrder(`state-${status}`, [{ accountId: supplierA, status }]);
      await assert.rejects(record(fixture, supplierA), status === "unassigned"
        ? /assigned fulfilment group not found/i
        : status === "delivered"
          ? /confirmed active order/i
        : /only for a packed fulfilment group/i);
    }
    const cancelled = await seedOrder("cancelled", [{ accountId: supplierA, status: "packed" }]);
    await adminDb.collection("orders").doc(cancelled.orderId).set({ status: "cancelled" }, { merge: true });
    await assert.rejects(record(cancelled, supplierA), /confirmed active order/i);
  });

  await t.test("duplicate and concurrent supplier submissions produce one shipment and one audit", async () => {
    const fixture = await seedOrder("concurrent", [{ accountId: supplierA, status: "packed" }]);
    const before = await trackingState(fixture, supplierA);
    const inputs = ["FIRST", "SECOND"].map((trackingNumber) => recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: before.group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: before.group.revision,
      expectedOrderPrivateRevision: before.privateOrder.revision,
      courierName: "Concurrent Courier",
      trackingNumber,
    }));
    const results = await Promise.allSettled(inputs);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await assert.rejects(recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: before.group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: before.group.revision,
      expectedOrderPrivateRevision: before.privateOrder.revision,
      courierName: "Concurrent Courier",
      trackingNumber: "FIRST",
    }), /state changed/i);
    const current = await trackingState(fixture, supplierA);
    assert.equal(current.group.revision, 2);
    assert.equal(current.group.tracking?.revision, 1);
    const audits = await adminDb.collection("supplier_operations_audit").where("orderId", "==", fixture.orderId).get();
    assert.equal(audits.docs.filter((entry) => entry.data().action === "tracking_recorded").length, 1);
  });

  await t.test("multi-supplier tracking remains isolated and aggregate order state advances only when all groups ship", async () => {
    const fixture = await seedOrder("multi", [
      { accountId: supplierA, status: "packed" },
      { accountId: supplierB, status: "packed" },
    ]);
    await record(fixture, supplierA, { trackingNumber: "TRACK-A" });
    let publicOrder = (await adminDb.collection("orders").doc(fixture.orderId).get()).data()!;
    assert.equal(publicOrder.status, "packed");
    assert.equal(publicOrder.shipments.length, 1);
    await record(fixture, supplierB, { trackingNumber: "TRACK-B" });
    publicOrder = (await adminDb.collection("orders").doc(fixture.orderId).get()).data()!;
    assert.equal(publicOrder.status, "shipped");
    assert.equal(publicOrder.shipments.length, 2);

    const password = "SH7D-Emulator-Password!";
    const supplierAEmail = `${supplierA}@example.test`;
    const supplierBEmail = `${supplierB}@example.test`;
    await Promise.all([
      ensureAuthUser(supplierA, supplierAEmail, password, { role: "supplier" }),
      ensureAuthUser(supplierB, supplierBEmail, password, { role: "supplier" }),
    ]);
    const app = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-supplier-isolation`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    try {
      const supplierAUser = await signInWithEmailAndPassword(auth, supplierAEmail, password);
      const supplierAResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal?pageSize=100`, {
        headers: { Authorization: `Bearer ${await supplierAUser.user.getIdToken(true)}` },
      });
      assert.equal(supplierAResponse.status, 200, await supplierAResponse.clone().text());
      const supplierAView = await supplierAResponse.json() as { orders: Array<Record<string, unknown>> };
      const projected = supplierAView.orders.find((order) => order.id === fixture.orderId);
      assert.ok(projected);
      assert.equal((projected.tracking as Record<string, unknown>).trackingNumber, "TRACK-A");
      assert.doesNotMatch(JSON.stringify(projected), /TRACK-B|purchaseSupplierCost|supplierOfferId|supplierSourceId/u);

      const supplierBUser = await signInWithEmailAndPassword(auth, supplierBEmail, password);
      const supplierBResponse = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal?pageSize=100`, {
        headers: { Authorization: `Bearer ${await supplierBUser.user.getIdToken(true)}` },
      });
      const supplierBView = await supplierBResponse.json() as { orders: Array<Record<string, unknown>> };
      const projectedB = supplierBView.orders.find((order) => order.id === fixture.orderId);
      assert.equal((projectedB?.tracking as Record<string, unknown>).trackingNumber, "TRACK-B");
      assert.doesNotMatch(JSON.stringify(projectedB), /TRACK-A/u);
    } finally {
      await deleteApp(app);
    }
  });

  await t.test("trusted Admin correction is revision-fenced, audited and unavailable to non-admins", async () => {
    const fixture = await seedOrder("correction", [{ accountId: supplierA, status: "packed" }]);
    await record(fixture, supplierA, { courierName: "Original Courier", trackingNumber: "ORIGINAL" });
    const before = await trackingState(fixture, supplierA);
    const corrected = await correctOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: before.group.groupId,
      adminUid,
      expectedGroupRevision: before.group.revision,
      expectedOrderPrivateRevision: before.privateOrder.revision,
      courierName: "Corrected Courier",
      trackingNumber: "CORRECTED",
    });
    assert.equal(corrected.status, "shipped");
    assert.equal(corrected.tracking.revision, 2);
    assert.equal(corrected.tracking.recordedBy, adminUid);
    await assert.rejects(correctOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: before.group.groupId,
      adminUid,
      expectedGroupRevision: before.group.revision,
      expectedOrderPrivateRevision: before.privateOrder.revision,
      courierName: "Stale",
      trackingNumber: "STALE",
    }), /state changed/i);
    await assert.rejects(record(fixture, supplierA), /already been recorded|only for a packed/i);
    const correctionAudits = await adminDb.collection("supplier_operations_audit").where("orderId", "==", fixture.orderId).get();
    const correctionAudit = correctionAudits.docs.find((entry) => entry.data().action === "tracking_corrected");
    assert.ok(correctionAudit);
    assert.deepEqual(correctionAudit.data().metadata, {
      previousCourierName: "Original Courier",
      previousTrackingNumber: "ORIGINAL",
    });

    const password = "SH7D-Admin-Password!";
    const supplierEmail = `${supplierA}@example.test`;
    await ensureAuthUser(supplierA, supplierEmail, password, { role: "supplier" });
    const app = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-non-admin`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    try {
      const supplierUser = await signInWithEmailAndPassword(auth, supplierEmail, password);
      const response = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal/orders/${fixture.orderId}/groups/${fixture.groupIds[supplierA]}/tracking/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await supplierUser.user.getIdToken(true)}` },
        body: JSON.stringify({ courierName: "Hijack", trackingNumber: "HIJACK", expectedGroupRevision: 3, expectedOrderPrivateRevision: 3 }),
      });
      assert.equal(response.status, 403);
    } finally {
      await deleteApp(app);
    }
  });

  await t.test("HTTP tracking uses revocation-aware supplier auth and rejects arbitrary URL fields", async () => {
    const fixture = await seedOrder("http", [{ accountId: supplierA, status: "packed" }]);
    const password = "SH7D-HTTP-Password!";
    const email = `${supplierA}@example.test`;
    await ensureAuthUser(supplierA, email, password, { role: "supplier" });
    const app = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-http`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    try {
      const signedIn = await signInWithEmailAndPassword(auth, email, password);
      const token = await signedIn.user.getIdToken(true);
      const state = await trackingState(fixture, supplierA);
      const rejectedUrl = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal/orders/${fixture.orderId}/groups/${state.group.groupId}/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          courierName: "HTTP Courier",
          trackingNumber: "HTTP-1",
          trackingUrl: "javascript:alert(1)",
          expectedGroupRevision: state.group.revision,
          expectedOrderPrivateRevision: state.privateOrder.revision,
        }),
      });
      assert.equal(rejectedUrl.status, 400);
      assert.equal((await trackingState(fixture, supplierA)).group.status, "packed");
      const accepted = await fetch(`http://${functionsHost}/${projectId}/us-central1/api/api/supplier-portal/orders/${fixture.orderId}/groups/${state.group.groupId}/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          courierName: "HTTP Courier",
          trackingNumber: "HTTP-1",
          expectedGroupRevision: state.group.revision,
          expectedOrderPrivateRevision: state.privateOrder.revision,
        }),
      });
      assert.equal(accepted.status, 200, await accepted.clone().text());
    } finally {
      await deleteApp(app);
    }
    await assert.rejects(verifySupplierPortalIdentityToken({
      verifyIdToken: async (_token, checkRevoked) => {
        assert.equal(checkRevoked, true);
        throw Object.assign(new Error("ID token revoked"), { code: "auth/id-token-revoked" });
      },
    }, "revoked-token", true), /revoked/i);
    assert.match(readFileSync("functions/src/api/app.ts", "utf8"), /verifyToken\(token\)/u);
  });

  await t.test("customer Rules/projection, Admin delivery and legacy compatibility remain safe", async () => {
    const fixture = await seedOrder("delivery", [
      { accountId: supplierA, status: "packed" },
      { accountId: supplierB, status: "packed" },
    ]);
    await record(fixture, supplierA, { trackingNumber: "DELIVERY-A" });
    await record(fixture, supplierB, { trackingNumber: "DELIVERY-B" });
    const publicBefore = (await adminDb.collection("orders").doc(fixture.orderId).get()).data()!;
    const customerOrder = normalizeCustomerOrder(fixture.orderId, publicBefore);
    assert.equal(customerOrder.shipments.length, 2);
    assert.equal(customerOrder.shipments.every((shipment) => shipment.trackingUrl === null), true);
    assert.doesNotMatch(JSON.stringify(customerOrder), /supplierAccountId|supplierSourceId|supplierOfferId|supplierItemCode|purchaseSupplierCost/u);

    const privateBefore = await readPrivate(fixture.orderId);
    const trackingBefore = privateBefore.fulfilmentGroups.map((group) => group.tracking);
    await updateOrderStatus(fixture.orderId, "delivered", undefined, adminDb, {
      adminUid,
      expectedOrderPrivateRevision: privateBefore.revision,
      expectedGroupRevisions: Object.fromEntries(privateBefore.fulfilmentGroups.map((group) => [group.groupId, group.revision])),
    });
    const privateAfter = await readPrivate(fixture.orderId);
    assert.deepEqual(privateAfter.fulfilmentGroups.map((group) => group.tracking), trackingBefore);
    const deliveredPublic = (await adminDb.collection("orders").doc(fixture.orderId).get()).data()!;
    assert.equal(deliveredPublic.shipments.every((shipment: Record<string, unknown>) => shipment.status === "delivered"), true);

    const [host, portText] = firestoreHost!.split(":");
    const rulesEnvironment = await initializeTestEnvironment({
      projectId: projectId!,
      firestore: { host, port: Number(portText), rules: readFileSync("firestore.rules", "utf8") },
    });
    try {
      const customerDb = rulesEnvironment.authenticatedContext(customerUid).firestore();
      const supplierDb = rulesEnvironment.authenticatedContext(supplierA, { role: "supplier" }).firestore();
      await assertSucceeds(getDoc(doc(customerDb, "orders", fixture.orderId)));
      await assertFails(getDoc(doc(customerDb, "order_private", fixture.orderId)));
      await assertFails(setDoc(doc(customerDb, "order_private", fixture.orderId), { revision: 99 }));
      await assertFails(deleteDoc(doc(customerDb, "order_private", fixture.orderId)));
      await assertFails(updateDoc(doc(customerDb, "orders", fixture.orderId), { shipments: [] }));
      await assertFails(getDoc(doc(supplierDb, "order_private", fixture.orderId)));
    } finally {
      await rulesEnvironment.cleanup();
    }

    const legacyOrderId = `${prefix}-legacy-order`;
    await adminDb.collection("orders").doc(legacyOrderId).set({
      customerUid,
      orderNumber: "SH7D-LEGACY",
      status: "shipped",
      stockReservationStatus: "committed",
      stockRestorationApplied: false,
      items: [],
    });
    await assert.rejects(recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: legacyOrderId,
      groupId: "legacy-group",
      supplierAccountId: supplierA,
      expectedGroupRevision: 1,
      expectedOrderPrivateRevision: 1,
      courierName: "Courier",
      trackingNumber: "LEGACY",
    }), /legacy order/i);
    assert.equal((await adminDb.collection("orders").doc(legacyOrderId).get()).data()?.shipments, undefined);
  });
});
