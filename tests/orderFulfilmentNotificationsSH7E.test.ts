import assert from "node:assert/strict";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import {
  assignOrderFulfilmentGroup,
  deriveOrderStatusFromFulfilmentGroups,
  fulfilmentEventId,
  parseOrderPrivateFulfilment,
  recordOrderFulfilmentTracking,
  transitionOrderFulfilmentGroup,
} from "../functions/src/api/orders/orderFulfilmentGroups";
import {
  fulfilmentNotificationId,
} from "../functions/src/api/orders/orderFulfilmentNotifications";
import { ORDER_EMAIL_MAX_ATTEMPTS } from "../functions/src/api/orders/orderNotificationLogic";
import {
  buildOrderPrivateDocument,
  type OrderPrivateAttributionLine,
} from "../functions/src/api/orders/orderPrivateAttribution";
import { updateOrderStatus } from "../functions/src/api/routes/orders";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRun = Boolean(
  firestoreHost && authHost && functionsHost && storageHost && projectId?.startsWith("demo-"),
);
const prefix = "sh7e-fulfilment-notifications";
const adminUid = `${prefix}-admin`;
const supplierA = `${prefix}-supplier-a`;
const supplierB = `${prefix}-supplier-b`;
const customerUid = `${prefix}-customer`;
const timestamp = "2026-08-11T00:00:00.000Z";

interface Fixture {
  orderId: string;
  groupIds: Record<string, string>;
}

const supplierEmail = (accountId: string): string => `${accountId}@example.test`;

const makeLine = (scenario: string, index: number, accountId: string): OrderPrivateAttributionLine => ({
  lineId: `${prefix}-${scenario}-line-${index}`,
  productId: `${prefix}-${scenario}-product-${index}`,
  zyroSku: `ZY-SH7E-${scenario.toUpperCase()}-${index}`,
  fulfilmentMode: "supplier",
  supplierOfferId: `${prefix}-${scenario}-offer-${index}`,
  supplierOfferStateVersion: 17,
  supplierSourceId: `${prefix}-${scenario}-${accountId}-source`,
  supplierId: `${prefix}-${scenario}-${accountId}-catalog`,
  supplierAccountId: accountId,
  supplierProductId: `${prefix}-${scenario}-supplier-product-${index}`,
  supplierItemCode: `PRIVATE-${scenario.toUpperCase()}-${index}`,
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

const deleteQuery = async (query: FirebaseFirestore.Query): Promise<void> => {
  const snapshot = await query.get();
  if (snapshot.empty) return;
  const batch = adminDb.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
};

const cleanupOrderArtifacts = async (orderId: string): Promise<void> => {
  const outbox = await adminDb.collection("notification_outbox").where("orderId", "==", orderId).get();
  if (!outbox.empty) {
    const batch = adminDb.batch();
    outbox.docs.forEach((document) => {
      batch.delete(document.ref);
      batch.delete(adminDb.collection("mail").doc(document.id));
    });
    await batch.commit();
  }
  await Promise.all([
    deleteQuery(adminDb.collection("supplier_notifications").where("orderId", "==", orderId)),
    deleteQuery(adminDb.collection("supplier_operations_audit").where("orderId", "==", orderId)),
    deleteQuery(adminDb.collection("mail").where("metadata.orderId", "==", orderId)),
    adminDb.collection("orders").doc(orderId).delete(),
    adminDb.collection("order_private").doc(orderId).delete(),
  ]);
};

const seedSupplier = async (accountId: string): Promise<void> => {
  await Promise.all([
    adminDb.collection("users").doc(accountId).set({
      role: "supplier",
      email: supplierEmail(accountId),
    }),
    adminDb.collection("supplier_profiles").doc(accountId).set({
      supplierId: accountId,
      companyName: `Company ${accountId}`,
      profileStatus: "active",
      email: supplierEmail(accountId),
    }),
  ]);
};

const seedOrder = async (
  scenario: string,
  groups: Array<{ accountId: string; status: "unassigned" | "assigned" | "accepted" | "processing" | "packed" | "shipped" | "delivered" }>,
): Promise<Fixture> => {
  const orderId = `${prefix}-${scenario}-order`;
  await cleanupOrderArtifacts(orderId);
  const lines = groups.map((group, index) => makeLine(scenario, index + 1, group.accountId));
  const privateOrder = buildOrderPrivateDocument(orderId, lines, timestamp);
  privateOrder.fulfilmentGroups = privateOrder.fulfilmentGroups.map((group) => setGroupStatus(
    group,
    groups.find((candidate) => candidate.accountId === group.supplierAccountId)?.status || "unassigned",
  ));
  privateOrder.assignedSupplierAccountIds = privateOrder.fulfilmentGroups
    .filter((group) => group.status !== "unassigned")
    .map((group) => group.supplierAccountId)
    .sort();
  const status = deriveOrderStatusFromFulfilmentGroups(privateOrder.fulfilmentGroups);
  await Promise.all([
    adminDb.collection("settings").doc("website").set({
      emailNotificationsEnabled: true,
      orderNotificationsEnabled: true,
    }, { merge: true }),
    ...[...new Set(groups.map((group) => group.accountId))].map(seedSupplier),
    ...lines.map((line) => adminDb.collection("supplierSources").doc(line.supplierSourceId!).set({
      supplierId: line.supplierId,
      supplierAccountId: line.supplierAccountId,
      supplierName: line.supplierSourceId,
      connectorType: "http",
      sourceStatus: "active",
      enabled: true,
      authentication: { mode: "none" },
    })),
    adminDb.collection("orders").doc(orderId).set({
      orderNumber: `SH7E-${scenario.toUpperCase()}`,
      customerUid,
      customerName: "SH-7E Customer",
      customerEmail: "sh7e-customer@example.test",
      customerPhone: "0771000000",
      customerAddress: "1 Emulator Road",
      district: "Colombo",
      city: "Colombo",
      status,
      paymentMethod: "cod",
      paymentStatus: "not_required",
      stockDeducted: true,
      stockReservationStatus: "committed",
      stockRestorationApplied: false,
      supplierAssignmentActive: privateOrder.assignedSupplierAccountIds.length > 0,
      supplierFulfilmentStatus: ["processing", "packed", "shipped", "delivered"].includes(status) ? status : "pending",
      items: lines.map((line, index) => ({
        productId: line.productId,
        name: `Customer Product ${scenario} ${index + 1}`,
        price: 1_500 + index,
        quantity: index + 1,
        imageUrl: "https://cdn.example.test/sh7e.jpg",
      })),
      totalPrice: lines.reduce((total, _line, index) => total + ((1_500 + index) * (index + 1)), 0),
      createdAt: timestamp,
    }),
    adminDb.collection("order_private").doc(orderId).set(privateOrder),
  ]);
  return {
    orderId,
    groupIds: Object.fromEntries(privateOrder.fulfilmentGroups.map((group) => [group.supplierAccountId, group.groupId])),
  };
};

const readPrivate = async (orderId: string) => {
  const snapshot = await adminDb.collection("order_private").doc(orderId).get();
  assert.equal(snapshot.exists, true);
  return parseOrderPrivateFulfilment(orderId, snapshot.data());
};

const outboxFor = async (orderId: string, kind: string) => {
  const snapshot = await adminDb.collection("notification_outbox").where("orderId", "==", orderId).get();
  return snapshot.docs.filter((document) => document.data().kind === kind);
};

const assertNoPrivateCustomerData = (value: unknown): void => {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /supplierAccountId|supplierSourceId|supplierOfferId|supplierItemCode|purchaseSupplierCost|PRIVATE-/u);
};

test("SH-7E fulfilment notifications are atomic, idempotent, and privacy-safe", {
  skip: canRun ? undefined : "Firestore, Auth, Functions, and Storage Emulators are required.",
  timeout: 300_000,
}, async (t) => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(authHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(storageHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);

  await t.test("assignment creates one group-scoped supplier notification and retry creates none", async () => {
    const fixture = await seedOrder("assignment", [
      { accountId: supplierA, status: "unassigned" },
      { accountId: supplierB, status: "unassigned" },
    ]);
    const before = await readPrivate(fixture.orderId);
    const group = before.fulfilmentGroups.find((candidate) => candidate.supplierAccountId === supplierA)!;
    const result = await assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: group.revision,
      expectedOrderPrivateRevision: before.revision,
      adminUid,
    });
    const event = fulfilmentEventId(fixture.orderId, group.groupId, "assigned", result.groupRevision);
    const notificationId = fulfilmentNotificationId(event, fixture.orderId, "supplier_fulfilment_assigned", supplierA);
    const notification = (await adminDb.collection("supplier_notifications").doc(notificationId).get()).data()!;
    assert.equal(notification.supplierId, supplierA);
    assert.equal(notification.audience, "supplier");
    assert.equal(notification.lines.length, 1);
    assert.match(notification.message, /Customer Product assignment 1 x 1/u);
    assert.doesNotMatch(JSON.stringify(notification), /product-2|PRIVATE-|purchaseSupplierCost|supplierOfferId|supplierSourceId/u);
    const emailId = fulfilmentNotificationId(event, fixture.orderId, "supplier_fulfilment_assigned", supplierEmail(supplierA));
    assert.equal((await adminDb.collection("notification_outbox").doc(emailId).get()).exists, true);
    assert.equal((await adminDb.collection("mail").doc(emailId).get()).exists, true);

    const current = await readPrivate(fixture.orderId);
    const currentGroup = current.fulfilmentGroups.find((candidate) => candidate.groupId === group.groupId)!;
    await assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: currentGroup.revision,
      expectedOrderPrivateRevision: current.revision,
      adminUid,
    });
    assert.equal((await outboxFor(fixture.orderId, "supplier_fulfilment_assigned")).length, 1);
  });

  await t.test("decline creates one Admin notification while stale attempts create none", async () => {
    const fixture = await seedOrder("decline", [{ accountId: supplierA, status: "assigned" }]);
    const before = await readPrivate(fixture.orderId);
    const group = before.fulfilmentGroups[0];
    const result = await transitionOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: group.groupId,
      supplierAccountId: supplierA,
      nextStatus: "unassigned",
      reason: "Warehouse capacity unavailable",
      expectedGroupRevision: group.revision,
      expectedOrderPrivateRevision: before.revision,
    });
    const event = fulfilmentEventId(fixture.orderId, group.groupId, "declined", result.groupRevision);
    const notificationId = fulfilmentNotificationId(event, fixture.orderId, "admin_fulfilment_declined", "admin");
    const notification = (await adminDb.collection("supplier_notifications").doc(notificationId).get()).data()!;
    assert.equal(notification.audience, "admin");
    assert.equal(notification.supplierId, undefined);
    assert.match(notification.message, /Warehouse capacity unavailable/u);
    assert.equal((await outboxFor(fixture.orderId, "admin_fulfilment_declined")).length, 1);
    await assert.rejects(transitionOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: group.groupId,
      supplierAccountId: supplierA,
      nextStatus: "unassigned",
      reason: "Duplicate",
      expectedGroupRevision: group.revision,
      expectedOrderPrivateRevision: before.revision,
    }), /refresh|not found/i);
    assert.equal((await outboxFor(fixture.orderId, "admin_fulfilment_declined")).length, 1);

    const staleFixture = await seedOrder("stale", [{ accountId: supplierA, status: "unassigned" }]);
    const stale = await readPrivate(staleFixture.orderId);
    await assert.rejects(assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: staleFixture.orderId,
      groupId: stale.fulfilmentGroups[0].groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: 99,
      expectedOrderPrivateRevision: stale.revision,
      adminUid,
    }), /refresh/i);
    assert.equal((await outboxFor(staleFixture.orderId, "supplier_fulfilment_assigned")).length, 0);
    assert.equal((await adminDb.collection("supplier_notifications").where("orderId", "==", staleFixture.orderId).get()).empty, true);
  });

  await t.test("shipment creates one customer-safe email and duplicate tracking cannot duplicate it", async () => {
    const fixture = await seedOrder("shipment", [{ accountId: supplierA, status: "packed" }]);
    const before = await readPrivate(fixture.orderId);
    const group = before.fulfilmentGroups[0];
    await recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: group.revision,
      expectedOrderPrivateRevision: before.revision,
      courierName: "Manual Courier",
      trackingNumber: "LK-SH7E-001",
    });
    const shipmentEmails = await outboxFor(fixture.orderId, "customer_fulfilment_shipped");
    assert.equal(shipmentEmails.length, 1);
    const mail = (await adminDb.collection("mail").doc(shipmentEmails[0].id).get()).data()!;
    assert.match(mail.message.text, /Manual Courier/u);
    assert.match(mail.message.text, /LK-SH7E-001/u);
    assertNoPrivateCustomerData(mail);
    await assert.rejects(recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: group.groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: group.revision,
      expectedOrderPrivateRevision: before.revision,
      courierName: "Duplicate Courier",
      trackingNumber: "DUPLICATE",
    }), /refresh|already/i);
    assert.equal((await outboxFor(fixture.orderId, "customer_fulfilment_shipped")).length, 1);
  });

  await t.test("delivery creates one customer-safe email and repeated delivery creates none", async () => {
    const fixture = await seedOrder("delivery", [{ accountId: supplierA, status: "packed" }]);
    const beforeTracking = await readPrivate(fixture.orderId);
    await recordOrderFulfilmentTracking({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: beforeTracking.fulfilmentGroups[0].groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: beforeTracking.fulfilmentGroups[0].revision,
      expectedOrderPrivateRevision: beforeTracking.revision,
      courierName: "Delivery Courier",
      trackingNumber: "DELIVERED-1",
    });
    const beforeDelivery = await readPrivate(fixture.orderId);
    await updateOrderStatus(fixture.orderId, "delivered", undefined, adminDb, {
      adminUid,
      expectedOrderPrivateRevision: beforeDelivery.revision,
      expectedGroupRevisions: Object.fromEntries(beforeDelivery.fulfilmentGroups.map((group) => [group.groupId, group.revision])),
    });
    const deliveryEmails = await outboxFor(fixture.orderId, "customer_fulfilment_delivered");
    assert.equal(deliveryEmails.length, 1);
    const mail = (await adminDb.collection("mail").doc(deliveryEmails[0].id).get()).data()!;
    assert.match(mail.message.text, /Delivery is confirmed/u);
    assertNoPrivateCustomerData(mail);
    await updateOrderStatus(fixture.orderId, "delivered", undefined, adminDb, { adminUid });
    assert.equal((await outboxFor(fixture.orderId, "customer_fulfilment_delivered")).length, 1);
  });

  await t.test("outbox records preserve the existing delivery/retry contract", async () => {
    const fixture = await seedOrder("outbox-contract", [{ accountId: supplierA, status: "unassigned" }]);
    const before = await readPrivate(fixture.orderId);
    await assignOrderFulfilmentGroup({
      db: adminDb,
      orderId: fixture.orderId,
      groupId: before.fulfilmentGroups[0].groupId,
      supplierAccountId: supplierA,
      expectedGroupRevision: before.fulfilmentGroups[0].revision,
      expectedOrderPrivateRevision: before.revision,
      adminUid,
    });
    const records = await outboxFor(fixture.orderId, "supplier_fulfilment_assigned");
    assert.equal(records.length, 1);
    assert.deepEqual({
      channel: records[0].data().channel,
      status: records[0].data().status,
      provider: records[0].data().provider,
      attemptCount: records[0].data().attemptCount,
      maxAttempts: records[0].data().maxAttempts,
      currentMailId: records[0].data().currentMailId,
    }, {
      channel: "email",
      status: "handed_off",
      provider: "firebase-trigger-email",
      attemptCount: 1,
      maxAttempts: ORDER_EMAIL_MAX_ATTEMPTS,
      currentMailId: records[0].id,
    });
  });
});
