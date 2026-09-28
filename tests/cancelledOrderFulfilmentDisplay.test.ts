import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { updateOrderStatus } from "../functions/src/api/routes/orders";
import {
  assignOrderFulfilmentGroup,
  correctOrderFulfilmentTracking,
  parseOrderPrivateFulfilment,
  recordOrderFulfilmentTracking,
  transitionOrderFulfilmentGroup,
} from "../functions/src/api/orders/orderFulfilmentGroups";
import { assertOrderCanProgressSupplierFulfilment } from "../functions/src/api/orders/orderStatusLogic";
import {
  calculateSupplierSummary,
  deriveSupplierOrderNotifications,
  supplierOrderIsCancelled,
} from "../functions/src/api/suppliers/supplierPortalLogic";
import { supplierOrderDisplayStatus } from "../src/features/supplier-portal/orderDisplay";

const ORDER_ID = "cancel-cleanup-order";
const PRODUCT_ID = "cancel-cleanup-product";
const SUPPLIER_ID = "cancel-cleanup-supplier";
const GROUP_ID = "cancel-cleanup-group";
const CAPTURED_AT = "2026-09-28T10:00:00.000Z";

type Doc = Record<string, unknown>;

interface Write {
  kind: "update" | "set" | "create";
  path: string;
  data: Doc;
}

function createStore(seed: Record<string, Doc>) {
  const docs = new Map<string, Doc>(Object.entries(structuredClone(seed)));
  const writes: Write[] = [];
  const reference = (path: string) => ({ path, id: path.split("/").at(-1) });
  const snapshot = (ref: { path: string; id?: string }) => {
    const data = docs.get(ref.path);
    return { id: ref.id, exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
  };
  const transaction = {
    get: async (ref: { path: string }) => snapshot(ref),
    getAll: async (...refs: Array<{ path: string }>) => refs.map(snapshot),
    update: (ref: { path: string }, data: Doc) => {
      writes.push({ kind: "update", path: ref.path, data });
      docs.set(ref.path, { ...(docs.get(ref.path) || {}), ...data });
    },
    set: (ref: { path: string }, data: Doc, options?: { merge?: boolean }) => {
      writes.push({ kind: "set", path: ref.path, data });
      docs.set(ref.path, options?.merge ? { ...(docs.get(ref.path) || {}), ...data } : data);
    },
    create: (ref: { path: string }, data: Doc) => {
      writes.push({ kind: "create", path: ref.path, data });
      docs.set(ref.path, data);
    },
  };
  const db = {
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async <T>(handler: (tx: typeof transaction) => Promise<T>) => handler(transaction),
  } as unknown as FirebaseFirestore.Firestore;
  return { db, docs, writes };
}

const assignedGroup = () => ({
  groupId: GROUP_ID,
  lineIds: ["line-1"],
  supplierAccountId: SUPPLIER_ID,
  supplierSourceIds: ["source-a"],
  status: "assigned",
  revision: 1,
  assignedAt: CAPTURED_AT,
  assignedBy: "system:purchase-time-attribution",
  acceptedAt: null,
  processingAt: null,
  packedAt: null,
  shippedAt: null,
  deliveredAt: null,
  tracking: null,
  declineReason: null,
  createdAt: CAPTURED_AT,
  updatedAt: CAPTURED_AT,
});

const privateOrderDoc = () => ({
  orderId: ORDER_ID,
  revision: 1,
  lines: [{
    lineId: "line-1",
    productId: PRODUCT_ID,
    fulfilmentMode: "supplier",
    supplierAccountId: SUPPLIER_ID,
    supplierSourceId: "source-a",
  }],
  fulfilmentGroups: [assignedGroup()],
  assignedSupplierAccountIds: [SUPPLIER_ID],
  updatedAt: CAPTURED_AT,
});

const pendingOrderDoc = () => ({
  orderNumber: "ZY900777",
  status: "pending",
  customerUid: "guest",
  paymentMethod: "cod",
  paymentStatus: "pending",
  stockDeducted: true,
  stockReservationStatus: "reserved",
  supplierFulfilmentStatus: "pending",
  items: [{ productId: PRODUCT_ID, name: "Cleanup Product", price: 1000, quantity: 1 }],
});

const seed = (): Record<string, Doc> => ({
  [`orders/${ORDER_ID}`]: pendingOrderDoc(),
  [`order_private/${ORDER_ID}`]: privateOrderDoc(),
  [`products/${PRODUCT_ID}`]: { stock: 5 },
  [`product_private/${PRODUCT_ID}`]: {
    supplierMetadata: { inventoryLevel: 6, localDemand: { version: 1, quantity: 1, status: "tracked" } },
  },
  "settings/website": {},
  [`users/${SUPPLIER_ID}`]: { role: "supplier" },
  [`supplier_profiles/${SUPPLIER_ID}`]: { status: "active" },
});

const portalOrder = (order: Doc, groupStatus = "assigned") => ({
  id: ORDER_ID,
  orderNumber: String(order.orderNumber),
  status: String(order.status),
  supplierFulfilmentStatus: groupStatus as "assigned",
  attributionAvailable: true,
  createdAt: CAPTURED_AT,
});

async function cancelledStore() {
  const store = createStore(seed());
  await updateOrderStatus(ORDER_ID, "cancelled", undefined, store.db, { adminUid: "admin-test" });
  return store;
}

test("A: admin cancel of a pending assigned order releases stock and demand once and shows the group as closed", async () => {
  const store = await cancelledStore();
  const order = store.docs.get(`orders/${ORDER_ID}`)!;
  assert.equal(order.status, "cancelled");
  assert.equal(order.stockReservationStatus, "released");
  assert.equal(order.stockRestorationApplied, true);
  assert.equal(store.docs.get(`products/${PRODUCT_ID}`)!.stock, 6);
  const metadata = store.docs.get(`product_private/${PRODUCT_ID}`)!.supplierMetadata as Doc;
  assert.equal(metadata.inventoryLevel, 6);
  assert.deepEqual(metadata.localDemand, { version: 1, quantity: 0, status: "tracked" });
  assert.equal(supplierOrderIsCancelled(order), true);
  assert.equal(supplierOrderDisplayStatus(portalOrder(order)), "cancelled");
});

test("B: supplier and admin fulfilment actions are rejected after cancellation", async () => {
  const store = await cancelledStore();
  const order = store.docs.get(`orders/${ORDER_ID}`)!;
  assert.throws(
    () => assertOrderCanProgressSupplierFulfilment(order.status, order.stockReservationStatus, order.stockRestorationApplied),
    /confirmed active order/u,
  );
  const fence = { expectedGroupRevision: 1, expectedOrderPrivateRevision: 1 };
  const base = { db: store.db, orderId: ORDER_ID, groupId: GROUP_ID, ...fence };
  const tracking = { courierName: "Cleanup Courier", trackingNumber: "LK-CLEANUP-1" };
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["accept", () => transitionOrderFulfilmentGroup({ ...base, supplierAccountId: SUPPLIER_ID, nextStatus: "accepted" })],
    ["decline", () => transitionOrderFulfilmentGroup({ ...base, supplierAccountId: SUPPLIER_ID, nextStatus: "unassigned" })],
    ["progress", () => transitionOrderFulfilmentGroup({ ...base, supplierAccountId: SUPPLIER_ID, nextStatus: "processing" })],
    ["tracking", () => recordOrderFulfilmentTracking({ ...base, supplierAccountId: SUPPLIER_ID, ...tracking })],
    ["tracking correction", () => correctOrderFulfilmentTracking({ ...base, adminUid: "admin-test", ...tracking })],
    ["reassign", () => assignOrderFulfilmentGroup({ ...base, supplierAccountId: SUPPLIER_ID, adminUid: "admin-test" })],
  ];
  const writesBefore = store.writes.length;
  for (const [label, attempt] of attempts) {
    await assert.rejects(attempt, /confirmed active order/u, `${label} must be rejected for a cancelled order`);
  }
  assert.equal(store.writes.length, writesBefore);
  assert.equal(
    calculateSupplierSummary([], [], [portalOrder(order)]).activeOrders,
    0,
  );
});

test("C: supplier portal shows a closed cancelled state with no Assigned pill or actions", () => {
  const cancelled = portalOrder({ orderNumber: "ZY900777", status: "cancelled" });
  assert.equal(supplierOrderDisplayStatus(cancelled), "cancelled");
  assert.equal(supplierOrderDisplayStatus({ ...cancelled, attributionAvailable: false }), "cancelled");
  const portal = readFileSync("src/features/supplier-portal/SupplierPortal.tsx", "utf8");
  assert.match(portal, /<StatusPill status=\{supplierOrderDisplayStatus\(order\)\} \/>/u);
  assert.match(portal, /const locked = \['cancelled', 'delivered'\]\.includes\(order\.status\);/u);
  assert.match(portal, /order\.supplierFulfilmentStatus === 'assigned' && !locked && <button type="button" onClick=\{\(\) => void onStatus\('unassigned'\)\}/u);
  assert.match(portal, /next && !locked && <button/u);
  assert.match(portal, /!\['cancelled', 'delivered'\]\.includes\(order\.status\) && !order\.tracking && <form/u);
  const admin = readFileSync("src/components/AdminDashboard.tsx", "utf8");
  assert.match(admin, /\{selectedOrder\.status === 'cancelled' \? 'cancelled' : group\.status\}/u);
});

test("C2: admin shows no supplier assignment action for cancelled orders but keeps it for active eligible orders", () => {
  const admin = readFileSync("src/components/AdminDashboard.tsx", "utf8");
  const assignmentButtons = admin.match(/\{group\.status === 'unassigned'[^{]*&& <button type="button" onClick=\{\(\) => void handleAssignOrderSupplier\(/gu) || [];
  assert.equal(assignmentButtons.length, 1, "exactly one supplier assignment control must exist");
  assert.equal((admin.match(/handleAssignOrderSupplier\(selectedOrder\.id, group\)/gu) || []).length, 1);
  assert.equal(
    assignmentButtons[0],
    "{group.status === 'unassigned' && selectedOrder.status !== 'cancelled' && <button type=\"button\" onClick={() => void handleAssignOrderSupplier(",
  );
  assert.match(admin, /const canAssign = group\.status === 'unassigned'\s+&& !\['pending', 'cancelled', 'delivered'\]\.includes\(selectedOrder\.status\)\s+&& !updatingOrderStatus\[operationKey\];/u);
  assert.match(admin, /disabled=\{!canAssign\}[^>]*>\{group\.declineReason \? 'Reassign purchase supplier' : 'Assign purchase supplier'\}<\/button>/u);

  const renderedAction = (orderStatus: string, groupStatus: string, busy = false) => {
    const visible = groupStatus === "unassigned" && orderStatus !== "cancelled";
    const enabled = groupStatus === "unassigned" && !["pending", "cancelled", "delivered"].includes(orderStatus) && !busy;
    return { visible, enabled };
  };
  assert.deepEqual(renderedAction("cancelled", "unassigned"), { visible: false, enabled: false });
  assert.deepEqual(renderedAction("cancelled", "assigned"), { visible: false, enabled: false });
  for (const status of ["confirmed", "processing", "packed", "shipped"]) {
    assert.deepEqual(renderedAction(status, "unassigned"), { visible: true, enabled: true }, `${status} unassigned group stays assignable`);
  }
  assert.deepEqual(renderedAction("confirmed", "unassigned", true), { visible: true, enabled: false });
  assert.deepEqual(renderedAction("confirmed", "assigned"), { visible: false, enabled: false });
});

test("D: cancelled orders produce no derived Assigned order message and stored notifications are untouched", () => {
  const cancelled = portalOrder({ orderNumber: "ZY900777", status: "cancelled" });
  assert.deepEqual(deriveSupplierOrderNotifications([cancelled], new Set()), []);
  assert.deepEqual(deriveSupplierOrderNotifications([{ ...cancelled, status: " Cancelled " }], new Set()), []);
  const route = readFileSync("functions/src/api/routes/supplierPortal.ts", "utf8");
  assert.match(route, /\.\.\.deriveSupplierOrderNotifications\(orders, notifiedOrderIds\),/u);
  assert.match(route, /const storedNotifications = notificationSnapshot\.docs\.map\(/u);
  assert.match(route, /notifications: \[\.\.\.storedNotifications, \.\.\.derivedNotifications\]/u);
});

test("E: cancellation preserves purchase-time attribution and the stored group", async () => {
  const store = await cancelledStore();
  assert.equal(store.writes.some((write) => write.path.startsWith("order_private/")), false);
  assert.equal(store.writes.some((write) => write.path.startsWith("supplier_operations_audit/")), false);
  const stored = store.docs.get(`order_private/${ORDER_ID}`)!;
  assert.deepEqual(stored, privateOrderDoc());
  const parsed = parseOrderPrivateFulfilment(ORDER_ID, stored);
  assert.deepEqual(parsed.assignedSupplierAccountIds, [SUPPLIER_ID]);
  assert.equal(parsed.fulfilmentGroups[0].supplierAccountId, SUPPLIER_ID);
  assert.equal(parsed.fulfilmentGroups[0].assignedBy, "system:purchase-time-attribution");
  assert.equal(parsed.fulfilmentGroups[0].assignedAt, CAPTURED_AT);
});

test("F: repeated cancel does not restore stock twice or touch the group revision", async () => {
  const store = await cancelledStore();
  const writesBefore = store.writes.length;
  const result = await updateOrderStatus(ORDER_ID, "cancelled", undefined, store.db, { adminUid: "admin-test" });
  assert.deepEqual(result, { status: "cancelled", stockRestored: false });
  const repeatWrites = store.writes.slice(writesBefore);
  assert.deepEqual(repeatWrites.map((write) => write.path), [`orders/${ORDER_ID}`]);
  assert.deepEqual(Object.keys(repeatWrites[0].data).sort(), ["status", "statusUpdatedAt"]);
  assert.equal(store.docs.get(`products/${PRODUCT_ID}`)!.stock, 6);
  const metadata = store.docs.get(`product_private/${PRODUCT_ID}`)!.supplierMetadata as Doc;
  assert.deepEqual(metadata.localDemand, { version: 1, quantity: 0, status: "tracked" });
  const parsed = parseOrderPrivateFulfilment(ORDER_ID, store.docs.get(`order_private/${ORDER_ID}`));
  assert.equal(parsed.revision, 1);
  assert.equal(parsed.fulfilmentGroups[0].revision, 1);
});

test("G: normal assigned orders keep the Assigned state, message and supplier actions", () => {
  for (const status of ["pending", "confirmed"]) {
    const order = portalOrder({ orderNumber: "ZY900778", status });
    assert.equal(supplierOrderIsCancelled(order), false);
    assert.equal(supplierOrderDisplayStatus(order), "assigned");
    assert.deepEqual(deriveSupplierOrderNotifications([order], new Set()), [{
      id: `order-${ORDER_ID}`,
      type: "new_order",
      title: "Assigned order",
      message: "Order ZY900778 is assigned to your account.",
      isRead: false,
      createdAt: CAPTURED_AT,
    }]);
    assert.equal(calculateSupplierSummary([], [], [order]).activeOrders, 1);
  }
  const notified = portalOrder({ orderNumber: "ZY900778", status: "confirmed" });
  assert.deepEqual(deriveSupplierOrderNotifications([notified], new Set([ORDER_ID])), []);
  assert.equal(supplierOrderDisplayStatus({ ...notified, attributionAvailable: false }), "legacy attribution unavailable");
  assert.doesNotThrow(() => assertOrderCanProgressSupplierFulfilment("confirmed", "committed", false));
});
