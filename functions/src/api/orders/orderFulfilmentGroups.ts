import { createHash } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { assertOrderCanProgressSupplierFulfilment } from "./orderStatusLogic";
import { normalizeSupplierSourceConfig } from "../suppliers/supplierSourceCompatibility";
import { SUPPLIER_PORTAL_SOURCE_ID } from "../suppliers/supplierPortalLogic";
import { getRuntimeConfig } from "../config";
import {
  createAdminDeclineNotification,
  createCustomerShipmentEmail,
  createSupplierAssignmentNotification,
  fulfilmentEmailNotificationsEnabled,
  projectFulfilmentNotificationLines,
} from "./orderFulfilmentNotifications";

export const ORDER_PRIVATE_COLLECTION = "order_private";
export const FULFILMENT_GROUP_STATUSES = [
  "unassigned", "assigned", "accepted", "processing", "packed", "shipped", "delivered",
] as const;

export type FulfilmentGroupStatus = typeof FULFILMENT_GROUP_STATUSES[number];

export interface FulfilmentGroupTracking {
  courierName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  recordedAt: string;
  recordedBy: string;
  revision: number;
}

export interface CustomerShipmentProjection {
  shipmentId: string;
  productIds: string[];
  status: "shipped" | "delivered";
  courierName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  shippedAt: string;
  deliveredAt: string | null;
}

export interface GroupableOrderPrivateLine {
  lineId: string;
  productId: string;
  fulfilmentMode: "supplier" | "internal";
  supplierAccountId: string | null;
  supplierSourceId: string | null;
}

export interface OrderFulfilmentGroup {
  groupId: string;
  lineIds: string[];
  supplierAccountId: string;
  supplierSourceIds: string[];
  status: FulfilmentGroupStatus;
  revision: number;
  assignedAt: string | null;
  assignedBy: string | null;
  acceptedAt: string | null;
  processingAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  tracking: FulfilmentGroupTracking | null;
  declineReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParsedOrderPrivateFulfilment {
  orderId: string;
  revision: number;
  lines: GroupableOrderPrivateLine[];
  fulfilmentGroups: OrderFulfilmentGroup[];
  assignedSupplierAccountIds: string[];
}

export interface FulfilmentMutationResult {
  orderId: string;
  groupId: string;
  status: FulfilmentGroupStatus;
  groupRevision: number;
  orderPrivateRevision: number;
  orderStatus: string;
}

interface MutationActor {
  type: "admin" | "supplier";
  uid: string;
}

const cleanText = (value: unknown, maximum = 300): string => typeof value === "string"
  ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, maximum)
  : "";

const positiveRevision = (value: unknown, label: string): number => {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new ApiError(`${label} is invalid`, 400);
  return revision;
};

const groupIdForAccount = (supplierAccountId: string): string => (
  `group-${createHash("sha256").update(supplierAccountId).digest("hex").slice(0, 32)}`
);

export const fulfilmentEventId = (
  orderId: string,
  groupId: string,
  action: string,
  groupRevision: number,
): string => `order-fulfilment-${createHash("sha256")
  .update(`${orderId}|${groupId}|${action}|${groupRevision}`)
  .digest("hex")}`;

const isGroupStatus = (value: string): value is FulfilmentGroupStatus => (
  (FULFILMENT_GROUP_STATUSES as readonly string[]).includes(value)
);

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

export function buildInitialFulfilmentGroups(
  lines: readonly GroupableOrderPrivateLine[],
  capturedAt: string,
): OrderFulfilmentGroup[] {
  const grouped = new Map<string, { lineIds: string[]; sourceIds: string[] }>();
  for (const line of lines) {
    if (line.fulfilmentMode === "internal") continue;
    const supplierAccountId = cleanText(line.supplierAccountId);
    const supplierSourceId = cleanText(line.supplierSourceId);
    if (!supplierAccountId || !supplierSourceId) {
      throw new ApiError(`Supplier attribution for product "${line.productId}" is incomplete`, 409);
    }
    const current = grouped.get(supplierAccountId) || { lineIds: [], sourceIds: [] };
    current.lineIds.push(line.lineId);
    current.sourceIds.push(supplierSourceId);
    grouped.set(supplierAccountId, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([supplierAccountId, group]) => ({
      groupId: groupIdForAccount(supplierAccountId),
      lineIds: sortedUnique(group.lineIds),
      supplierAccountId,
      supplierSourceIds: sortedUnique(group.sourceIds),
      status: "unassigned",
      revision: 1,
      assignedAt: null,
      assignedBy: null,
      acceptedAt: null,
      processingAt: null,
      packedAt: null,
      shippedAt: null,
      deliveredAt: null,
      tracking: null,
      declineReason: null,
      createdAt: capturedAt,
      updatedAt: capturedAt,
    }));
}

const parseLine = (value: unknown): GroupableOrderPrivateLine => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Fulfilment attribution is invalid", 409);
  const line = value as Record<string, unknown>;
  const lineId = cleanText(line.lineId, 180);
  const productId = cleanText(line.productId, 180);
  const fulfilmentMode = cleanText(line.fulfilmentMode, 20);
  if (!lineId || !productId || !["supplier", "internal"].includes(fulfilmentMode)) {
    throw new ApiError("Fulfilment attribution is invalid", 409);
  }
  return {
    lineId,
    productId,
    fulfilmentMode: fulfilmentMode as "supplier" | "internal",
    supplierAccountId: cleanText(line.supplierAccountId, 160) || null,
    supplierSourceId: cleanText(line.supplierSourceId, 160) || null,
  };
};

const parseGroup = (value: unknown): OrderFulfilmentGroup => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Fulfilment group data is invalid", 409);
  const group = value as Record<string, unknown>;
  const status = cleanText(group.status, 30).toLowerCase();
  const lineIds = Array.isArray(group.lineIds) ? group.lineIds.map((lineId) => cleanText(lineId, 180)).filter(Boolean) : [];
  const supplierSourceIds = Array.isArray(group.supplierSourceIds)
    ? group.supplierSourceIds.map((sourceId) => cleanText(sourceId, 160)).filter(Boolean)
    : [];
  if (!cleanText(group.groupId, 180)
    || !cleanText(group.supplierAccountId, 160)
    || lineIds.length === 0
    || !isGroupStatus(status)) {
    throw new ApiError("Fulfilment group data is invalid", 409);
  }
  let tracking: FulfilmentGroupTracking | null = null;
  if (group.tracking !== undefined && group.tracking !== null) {
    if (typeof group.tracking !== "object" || Array.isArray(group.tracking)) {
      throw new ApiError("Fulfilment tracking data is invalid", 409);
    }
    const rawTracking = group.tracking as Record<string, unknown>;
    const courierName = cleanText(rawTracking.courierName, 80);
    const trackingNumber = cleanText(rawTracking.trackingNumber, 120);
    const recordedAt = cleanText(rawTracking.recordedAt, 80);
    const recordedBy = cleanText(rawTracking.recordedBy, 160);
    if (!courierName || !trackingNumber || !recordedAt || !recordedBy) {
      throw new ApiError("Fulfilment tracking data is invalid", 409);
    }
    if (cleanText(rawTracking.trackingUrl, 2_000)) {
      throw new ApiError("Fulfilment tracking URL is not allowlisted", 409);
    }
    if (!["shipped", "delivered"].includes(status)) {
      throw new ApiError("Fulfilment tracking state is invalid", 409);
    }
    tracking = {
      courierName,
      trackingNumber,
      trackingUrl: null,
      recordedAt,
      recordedBy,
      revision: positiveRevision(rawTracking.revision, "Tracking revision"),
    };
  }
  return {
    groupId: cleanText(group.groupId, 180),
    lineIds: sortedUnique(lineIds),
    supplierAccountId: cleanText(group.supplierAccountId, 160),
    supplierSourceIds: sortedUnique(supplierSourceIds),
    status,
    revision: positiveRevision(group.revision, "Fulfilment group revision"),
    assignedAt: cleanText(group.assignedAt, 80) || null,
    assignedBy: cleanText(group.assignedBy, 160) || null,
    acceptedAt: cleanText(group.acceptedAt, 80) || null,
    processingAt: cleanText(group.processingAt, 80) || null,
    packedAt: cleanText(group.packedAt, 80) || null,
    shippedAt: cleanText(group.shippedAt, 80) || null,
    deliveredAt: cleanText(group.deliveredAt, 80) || null,
    tracking,
    declineReason: cleanText(group.declineReason, 500) || null,
    createdAt: cleanText(group.createdAt, 80),
    updatedAt: cleanText(group.updatedAt, 80),
  };
};

const assignedAccountIds = (groups: readonly OrderFulfilmentGroup[]): string[] => sortedUnique(
  groups.filter((group) => group.status !== "unassigned").map((group) => group.supplierAccountId),
);

export function parseOrderPrivateFulfilment(
  orderId: string,
  data: FirebaseFirestore.DocumentData | undefined,
): ParsedOrderPrivateFulfilment {
  if (!data || !Array.isArray(data.fulfilmentGroups)) {
    throw new ApiError("Fulfilment attribution unavailable for this legacy order", 409);
  }
  const lines = Array.isArray(data.lines) ? data.lines.map(parseLine) : [];
  const groups = data.fulfilmentGroups.map(parseGroup);
  const lineById = new Map(lines.map((line) => [line.lineId, line]));
  if (lineById.size !== lines.length || new Set(groups.map((group) => group.groupId)).size !== groups.length) {
    throw new ApiError("Fulfilment group data is inconsistent", 409);
  }
  const groupedLineIds = new Set<string>();
  const groupedAccounts = new Set<string>();
  for (const group of groups) {
    if (groupedAccounts.has(group.supplierAccountId)) throw new ApiError("Fulfilment group ownership is inconsistent", 409);
    groupedAccounts.add(group.supplierAccountId);
    const expectedSources: string[] = [];
    for (const lineId of group.lineIds) {
      const line = lineById.get(lineId);
      if (!line || line.fulfilmentMode !== "supplier" || line.supplierAccountId !== group.supplierAccountId || !line.supplierSourceId) {
        throw new ApiError("Fulfilment group line ownership is inconsistent", 409);
      }
      if (groupedLineIds.has(lineId)) throw new ApiError("An order line cannot belong to multiple fulfilment groups", 409);
      groupedLineIds.add(lineId);
      expectedSources.push(line.supplierSourceId);
    }
    if (JSON.stringify(sortedUnique(expectedSources)) !== JSON.stringify(group.supplierSourceIds)) {
      throw new ApiError("Fulfilment group source ownership is inconsistent", 409);
    }
  }
  const supplierLineIds = lines.filter((line) => line.fulfilmentMode === "supplier").map((line) => line.lineId).sort();
  if (JSON.stringify([...groupedLineIds].sort()) !== JSON.stringify(supplierLineIds)) {
    throw new ApiError("Supplier order lines are missing fulfilment groups", 409);
  }
  const projectedAccounts = Array.isArray(data.assignedSupplierAccountIds)
    ? sortedUnique(data.assignedSupplierAccountIds.map((value: unknown) => cleanText(value, 160)).filter(Boolean))
    : [];
  const expectedAccounts = assignedAccountIds(groups);
  if (JSON.stringify(projectedAccounts) !== JSON.stringify(expectedAccounts)) {
    throw new ApiError("Fulfilment assignment projection is inconsistent", 409);
  }
  return {
    orderId,
    revision: positiveRevision(data.revision, "Order fulfilment revision"),
    lines,
    fulfilmentGroups: groups,
    assignedSupplierAccountIds: projectedAccounts,
  };
}

export function deriveOrderStatusFromFulfilmentGroups(groups: readonly OrderFulfilmentGroup[]): string {
  if (groups.length === 0) return "confirmed";
  if (groups.every((group) => group.status === "delivered")) return "delivered";
  if (groups.every((group) => ["shipped", "delivered"].includes(group.status))) return "shipped";
  if (groups.every((group) => ["packed", "shipped", "delivered"].includes(group.status))) return "packed";
  if (groups.some((group) => ["accepted", "processing", "packed", "shipped", "delivered"].includes(group.status))) {
    return "processing";
  }
  return "confirmed";
}

const publicFulfilmentStatus = (groups: readonly OrderFulfilmentGroup[]): string => {
  const derived = deriveOrderStatusFromFulfilmentGroups(groups);
  return ["processing", "packed", "shipped", "delivered"].includes(derived) ? derived : "pending";
};

const assertRevisionFence = (
  privateOrder: ParsedOrderPrivateFulfilment,
  group: OrderFulfilmentGroup,
  expectedOrderPrivateRevision: unknown,
  expectedGroupRevision: unknown,
): void => {
  if (privateOrder.revision !== positiveRevision(expectedOrderPrivateRevision, "Order fulfilment revision")
    || group.revision !== positiveRevision(expectedGroupRevision, "Fulfilment group revision")) {
    throw new ApiError("Fulfilment state changed. Refresh and try again.", 409);
  }
};

const assertActiveSupplier = (
  supplierSnapshot: FirebaseFirestore.DocumentSnapshot,
  profileSnapshot: FirebaseFirestore.DocumentSnapshot,
): void => {
  if (!supplierSnapshot.exists || supplierSnapshot.data()?.role !== "supplier") {
    throw new ApiError("Selected account is not a supplier", 400);
  }
  if (!profileSnapshot.exists || cleanText(profileSnapshot.data()?.profileStatus, 30).toLowerCase() !== "active") {
    throw new ApiError("Selected supplier profile is not active", 409);
  }
};

const assertSourceMappings = async (
  db: FirebaseFirestore.Firestore,
  transaction: FirebaseFirestore.Transaction,
  group: OrderFulfilmentGroup,
): Promise<void> => {
  const sourceIds = group.supplierSourceIds.filter((sourceId) => sourceId !== SUPPLIER_PORTAL_SOURCE_ID);
  if (sourceIds.length === 0) return;
  const references = sourceIds.map((sourceId) => db.collection("supplierSources").doc(sourceId));
  const snapshots = await transaction.getAll(...references);
  for (const snapshot of snapshots) {
    if (!snapshot.exists) throw new ApiError("Supplier source routing is no longer available", 409);
    const source = normalizeSupplierSourceConfig(snapshot.id, snapshot.data()!);
    if (!source.enabled || source.supplierAccountId !== group.supplierAccountId) {
      throw new ApiError("Supplier source routing no longer matches the purchase-time supplier", 409);
    }
  }
};

const buildAudit = (
  orderId: string,
  group: OrderFulfilmentGroup,
  actor: MutationActor,
  action: string,
  fromState: FulfilmentGroupStatus,
  toState: FulfilmentGroupStatus,
  reason: string | null,
  trackingRevision?: number,
  metadata?: Record<string, unknown>,
): Record<string, unknown> => ({
  eventType: `order_fulfilment_${action}`,
  action,
  orderId,
  groupId: group.groupId,
  actorType: actor.type,
  actorUid: actor.uid,
  fromState,
  toState,
  affectedLineIds: [...group.lineIds],
  supplierAccountId: group.supplierAccountId,
  groupRevision: group.revision,
  ...(trackingRevision ? { trackingRevision } : {}),
  ...(metadata ? { metadata } : {}),
  ...(reason ? { reason } : {}),
  timestamp: FieldValue.serverTimestamp(),
});

const replaceGroup = (
  groups: readonly OrderFulfilmentGroup[],
  replacement: OrderFulfilmentGroup,
): OrderFulfilmentGroup[] => groups.map((group) => group.groupId === replacement.groupId ? replacement : group);

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

const validateTrackingText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string") throw new ApiError(`${label} is required`, 400);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) throw new ApiError(`${label} is required`, 400);
  if (CONTROL_CHARACTERS.test(value)) throw new ApiError(`${label} contains unsupported control characters`, 400);
  if ([...normalized].length > maximum) throw new ApiError(`${label} is too long`, 400);
  return normalized;
};

/**
 * No courier URL templates are currently verified in the repository. Keep the
 * customer URL absent until a reviewed, code-owned allowlist is introduced.
 */
export function deriveTrackingUrl(_courierName: string, _trackingNumber: string): null {
  return null;
}

export function validateTrackingInput(input: {
  courierName?: unknown;
  trackingNumber?: unknown;
  trackingUrl?: unknown;
}): Pick<FulfilmentGroupTracking, "courierName" | "trackingNumber" | "trackingUrl"> {
  if (input.trackingUrl !== undefined) {
    throw new ApiError("Tracking URL cannot be supplied by the client", 400);
  }
  const courierName = validateTrackingText(input.courierName, "Courier name", 80);
  const trackingNumber = validateTrackingText(input.trackingNumber, "Tracking number", 120);
  return { courierName, trackingNumber, trackingUrl: deriveTrackingUrl(courierName, trackingNumber) };
}

const shipmentId = (orderId: string, groupId: string): string => (
  `shipment-${createHash("sha256").update(`${orderId}|${groupId}`).digest("hex").slice(0, 32)}`
);

export function projectCustomerShipments(
  privateOrder: Pick<ParsedOrderPrivateFulfilment, "orderId" | "lines">,
  groups: readonly OrderFulfilmentGroup[],
): CustomerShipmentProjection[] {
  const productByLineId = new Map(privateOrder.lines.map((line) => [line.lineId, line.productId]));
  return groups.flatMap((group): CustomerShipmentProjection[] => {
    if (!group.tracking || !["shipped", "delivered"].includes(group.status) || !group.shippedAt) return [];
    const productIds = sortedUnique(group.lineIds.map((lineId) => productByLineId.get(lineId) || "").filter(Boolean));
    return [{
      shipmentId: shipmentId(privateOrder.orderId, group.groupId),
      productIds,
      status: group.status as "shipped" | "delivered",
      courierName: group.tracking.courierName,
      trackingNumber: group.tracking.trackingNumber,
      trackingUrl: group.tracking.trackingUrl,
      shippedAt: group.shippedAt,
      deliveredAt: group.deliveredAt,
    }];
  });
}

export async function assignOrderFulfilmentGroup(input: {
  db: FirebaseFirestore.Firestore;
  orderId: string;
  groupId: string;
  supplierAccountId: string;
  expectedGroupRevision: unknown;
  expectedOrderPrivateRevision: unknown;
  adminUid: string;
}): Promise<FulfilmentMutationResult> {
  const { db, orderId, groupId, supplierAccountId, adminUid } = input;
  const orderReference = db.collection("orders").doc(orderId);
  const privateReference = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
  const supplierReference = db.collection("users").doc(supplierAccountId);
  const profileReference = db.collection("supplier_profiles").doc(supplierAccountId);
  return db.runTransaction(async (transaction) => {
    const settingsReference = db.collection("settings").doc("website");
    const [orderSnapshot, privateSnapshot, supplierSnapshot, profileSnapshot, settingsSnapshot] = await transaction.getAll(
      orderReference, privateReference, supplierReference, profileReference, settingsReference,
    );
    if (!orderSnapshot.exists) throw new ApiError("Order not found", 404);
    if (!privateSnapshot.exists) throw new ApiError("Fulfilment attribution unavailable for this legacy order", 409);
    const order = orderSnapshot.data() || {};
    assertOrderCanProgressSupplierFulfilment(order.status, order.stockReservationStatus, order.stockRestorationApplied);
    assertActiveSupplier(supplierSnapshot, profileSnapshot);
    const privateOrder = parseOrderPrivateFulfilment(orderId, privateSnapshot.data());
    const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) throw new ApiError("Fulfilment group not found", 404);
    assertRevisionFence(privateOrder, group, input.expectedOrderPrivateRevision, input.expectedGroupRevision);
    if (group.supplierAccountId !== supplierAccountId) {
      throw new ApiError("The selected supplier is not authorized for every line in this group", 409);
    }
    await assertSourceMappings(db, transaction, group);
    if (group.status === "assigned") {
      return {
        orderId, groupId, status: group.status, groupRevision: group.revision,
        orderPrivateRevision: privateOrder.revision, orderStatus: cleanText(order.status, 30),
      };
    }
    if (group.status !== "unassigned") throw new ApiError("Fulfilment cannot be reassigned after supplier acceptance", 409);
    const now = new Date().toISOString();
    const nextGroup: OrderFulfilmentGroup = {
      ...group,
      status: "assigned",
      revision: group.revision + 1,
      assignedAt: now,
      assignedBy: adminUid,
      declineReason: null,
      updatedAt: now,
    };
    const groups = replaceGroup(privateOrder.fulfilmentGroups, nextGroup);
    const nextPrivateRevision = privateOrder.revision + 1;
    const actor: MutationActor = { type: "admin", uid: adminUid };
    const assignmentAction = group.declineReason ? "reassigned" : "assigned";
    const assignmentEventId = fulfilmentEventId(orderId, groupId, assignmentAction, nextGroup.revision);
    transaction.update(privateReference, {
      fulfilmentGroups: groups,
      assignedSupplierAccountIds: assignedAccountIds(groups),
      revision: nextPrivateRevision,
      updatedAt: now,
    });
    transaction.update(orderReference, {
      supplierAssignmentActive: true,
      supplierFulfilmentStatus: publicFulfilmentStatus(groups),
      supplierId: FieldValue.delete(),
      supplierIds: FieldValue.delete(),
      supplierAssignedAt: now,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(
      db.collection("supplier_operations_audit").doc(assignmentEventId),
      buildAudit(orderId, nextGroup, actor, assignmentAction, group.status, nextGroup.status, null),
    );
    createSupplierAssignmentNotification({
      transaction,
      db,
      eventId: assignmentEventId,
      orderId,
      orderNumber: cleanText(order.orderNumber, 80) || orderId,
      groupId,
      supplierAccountId,
      supplierEmail: supplierSnapshot.data()?.email ?? profileSnapshot.data()?.email,
      lines: projectFulfilmentNotificationLines(order, privateOrder, nextGroup),
      emailEnabled: fulfilmentEmailNotificationsEnabled(settingsSnapshot.data()),
    });
    return {
      orderId, groupId, status: nextGroup.status, groupRevision: nextGroup.revision,
      orderPrivateRevision: nextPrivateRevision, orderStatus: cleanText(order.status, 30),
    };
  });
}

const TRANSITIONS: Readonly<Record<FulfilmentGroupStatus, readonly FulfilmentGroupStatus[]>> = {
  unassigned: [],
  assigned: ["accepted", "unassigned"],
  accepted: ["processing"],
  processing: ["packed"],
  packed: [],
  shipped: [],
  delivered: [],
};

export async function transitionOrderFulfilmentGroup(input: {
  db: FirebaseFirestore.Firestore;
  orderId: string;
  groupId: string;
  supplierAccountId: string;
  nextStatus: unknown;
  expectedGroupRevision: unknown;
  expectedOrderPrivateRevision: unknown;
  reason?: unknown;
}): Promise<FulfilmentMutationResult> {
  const { db, orderId, groupId, supplierAccountId } = input;
  const nextStatusText = cleanText(input.nextStatus, 30).toLowerCase();
  if (nextStatusText === "shipped") {
    throw new ApiError("Tracking must be recorded to mark a fulfilment group as shipped", 409);
  }
  if (!isGroupStatus(nextStatusText) || !["unassigned", "accepted", "processing", "packed"].includes(nextStatusText)) {
    throw new ApiError("Fulfilment status is invalid", 400);
  }
  const nextStatus = nextStatusText as FulfilmentGroupStatus;
  const orderReference = db.collection("orders").doc(orderId);
  const privateReference = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
  const supplierReference = db.collection("users").doc(supplierAccountId);
  const profileReference = db.collection("supplier_profiles").doc(supplierAccountId);
  return db.runTransaction(async (transaction) => {
    const settingsReference = db.collection("settings").doc("website");
    const [orderSnapshot, privateSnapshot, supplierSnapshot, profileSnapshot, settingsSnapshot] = await transaction.getAll(
      orderReference, privateReference, supplierReference, profileReference, settingsReference,
    );
    if (!orderSnapshot.exists) throw new ApiError("Assigned order not found", 404);
    if (!privateSnapshot.exists) throw new ApiError("Fulfilment attribution unavailable for this legacy order", 409);
    const order = orderSnapshot.data() || {};
    assertOrderCanProgressSupplierFulfilment(order.status, order.stockReservationStatus, order.stockRestorationApplied);
    assertActiveSupplier(supplierSnapshot, profileSnapshot);
    const privateOrder = parseOrderPrivateFulfilment(orderId, privateSnapshot.data());
    const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.groupId === groupId);
    if (!group || group.supplierAccountId !== supplierAccountId || group.status === "unassigned") {
      throw new ApiError("Assigned fulfilment group not found", 404);
    }
    assertRevisionFence(privateOrder, group, input.expectedOrderPrivateRevision, input.expectedGroupRevision);
    if (group.status === nextStatus) {
      return {
        orderId, groupId, status: group.status, groupRevision: group.revision,
        orderPrivateRevision: privateOrder.revision, orderStatus: cleanText(order.status, 30),
      };
    }
    if (!TRANSITIONS[group.status].includes(nextStatus)) {
      throw new ApiError(`Fulfilment cannot move from ${group.status} to ${nextStatus}`, 409);
    }
    const reason = nextStatus === "unassigned"
      ? cleanText(input.reason, 500) || "Supplier declined the assigned fulfilment group."
      : null;
    const now = new Date().toISOString();
    const nextGroup: OrderFulfilmentGroup = {
      ...group,
      status: nextStatus,
      revision: group.revision + 1,
      ...(nextStatus === "unassigned" ? { assignedAt: null, assignedBy: null, declineReason: reason } : {}),
      ...(nextStatus === "accepted" ? { acceptedAt: now, declineReason: null } : {}),
      ...(nextStatus === "processing" ? { processingAt: now } : {}),
      ...(nextStatus === "packed" ? { packedAt: now } : {}),
      updatedAt: now,
    };
    const groups = replaceGroup(privateOrder.fulfilmentGroups, nextGroup);
    const nextPrivateRevision = privateOrder.revision + 1;
    const derivedOrderStatus = deriveOrderStatusFromFulfilmentGroups(groups);
    const action = nextStatus === "unassigned" ? "declined" : nextStatus;
    const actor: MutationActor = { type: "supplier", uid: supplierAccountId };
    const transitionEventId = fulfilmentEventId(orderId, groupId, action, nextGroup.revision);
    transaction.update(privateReference, {
      fulfilmentGroups: groups,
      assignedSupplierAccountIds: assignedAccountIds(groups),
      revision: nextPrivateRevision,
      updatedAt: now,
    });
    transaction.update(orderReference, {
      status: derivedOrderStatus,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      supplierAssignmentActive: assignedAccountIds(groups).length > 0,
      supplierFulfilmentStatus: publicFulfilmentStatus(groups),
      supplierFulfilmentUpdatedAt: now,
      supplierFulfilmentUpdatedBy: supplierAccountId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(
      db.collection("supplier_operations_audit").doc(transitionEventId),
      buildAudit(orderId, nextGroup, actor, action, group.status, nextStatus, reason),
    );
    if (nextStatus === "unassigned") {
      createAdminDeclineNotification({
        transaction,
        db,
        eventId: transitionEventId,
        orderId,
        orderNumber: cleanText(order.orderNumber, 80) || orderId,
        groupId,
        supplierAccountId,
        declineReason: reason || "Supplier declined the assigned fulfilment group.",
        adminEmail: getRuntimeConfig().adminEmail,
        emailEnabled: fulfilmentEmailNotificationsEnabled(settingsSnapshot.data()),
      });
    }
    return {
      orderId, groupId, status: nextGroup.status, groupRevision: nextGroup.revision,
      orderPrivateRevision: nextPrivateRevision, orderStatus: derivedOrderStatus,
    };
  });
}

export async function recordOrderFulfilmentTracking(input: {
  db: FirebaseFirestore.Firestore;
  orderId: string;
  groupId: string;
  supplierAccountId: string;
  expectedGroupRevision: unknown;
  expectedOrderPrivateRevision: unknown;
  courierName: unknown;
  trackingNumber: unknown;
  trackingUrl?: unknown;
}): Promise<FulfilmentMutationResult & { tracking: FulfilmentGroupTracking }> {
  const trackingInput = validateTrackingInput(input);
  const { db, orderId, groupId, supplierAccountId } = input;
  const orderReference = db.collection("orders").doc(orderId);
  const privateReference = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
  const supplierReference = db.collection("users").doc(supplierAccountId);
  const profileReference = db.collection("supplier_profiles").doc(supplierAccountId);
  return db.runTransaction(async (transaction) => {
    const settingsReference = db.collection("settings").doc("website");
    const [orderSnapshot, privateSnapshot, supplierSnapshot, profileSnapshot, settingsSnapshot] = await transaction.getAll(
      orderReference, privateReference, supplierReference, profileReference, settingsReference,
    );
    if (!orderSnapshot.exists) throw new ApiError("Assigned order not found", 404);
    if (!privateSnapshot.exists) throw new ApiError("Fulfilment attribution unavailable for this legacy order", 409);
    const order = orderSnapshot.data() || {};
    assertOrderCanProgressSupplierFulfilment(order.status, order.stockReservationStatus, order.stockRestorationApplied);
    assertActiveSupplier(supplierSnapshot, profileSnapshot);
    const privateOrder = parseOrderPrivateFulfilment(orderId, privateSnapshot.data());
    const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.groupId === groupId);
    if (!group || group.supplierAccountId !== supplierAccountId || group.status === "unassigned") {
      throw new ApiError("Assigned fulfilment group not found", 404);
    }
    assertRevisionFence(privateOrder, group, input.expectedOrderPrivateRevision, input.expectedGroupRevision);
    if (group.tracking) throw new ApiError("Tracking has already been recorded for this fulfilment group", 409);
    if (group.status !== "packed") throw new ApiError("Tracking can be recorded only for a packed fulfilment group", 409);

    const now = new Date().toISOString();
    const tracking: FulfilmentGroupTracking = {
      ...trackingInput,
      recordedAt: now,
      recordedBy: supplierAccountId,
      revision: 1,
    };
    const nextGroup: OrderFulfilmentGroup = {
      ...group,
      status: "shipped",
      revision: group.revision + 1,
      shippedAt: now,
      tracking,
      updatedAt: now,
    };
    const groups = replaceGroup(privateOrder.fulfilmentGroups, nextGroup);
    const nextPrivateRevision = privateOrder.revision + 1;
    const derivedOrderStatus = deriveOrderStatusFromFulfilmentGroups(groups);
    const trackingEventId = fulfilmentEventId(orderId, groupId, "tracking_recorded", nextGroup.revision);
    transaction.update(privateReference, {
      fulfilmentGroups: groups,
      assignedSupplierAccountIds: assignedAccountIds(groups),
      revision: nextPrivateRevision,
      updatedAt: now,
    });
    transaction.update(orderReference, {
      status: derivedOrderStatus,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      shipments: projectCustomerShipments(privateOrder, groups),
      supplierAssignmentActive: assignedAccountIds(groups).length > 0,
      supplierFulfilmentStatus: publicFulfilmentStatus(groups),
      supplierFulfilmentUpdatedAt: now,
      supplierFulfilmentUpdatedBy: supplierAccountId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(
      db.collection("supplier_operations_audit").doc(trackingEventId),
      {
        eventId: trackingEventId,
        ...buildAudit(
          orderId,
          nextGroup,
          { type: "supplier", uid: supplierAccountId },
          "tracking_recorded",
          group.status,
          nextGroup.status,
          null,
          tracking.revision,
        ),
      },
    );
    createCustomerShipmentEmail({
      transaction,
      db,
      eventId: trackingEventId,
      orderId,
      orderNumber: cleanText(order.orderNumber, 80) || orderId,
      groupId,
      customerEmail: order.customerEmail,
      courierName: tracking.courierName,
      trackingNumber: tracking.trackingNumber,
      trackingUrl: tracking.trackingUrl,
      lines: projectFulfilmentNotificationLines(order, privateOrder, nextGroup),
      emailEnabled: fulfilmentEmailNotificationsEnabled(settingsSnapshot.data()),
    });
    return {
      orderId,
      groupId,
      status: nextGroup.status,
      groupRevision: nextGroup.revision,
      orderPrivateRevision: nextPrivateRevision,
      orderStatus: derivedOrderStatus,
      tracking,
    };
  });
}

export async function correctOrderFulfilmentTracking(input: {
  db: FirebaseFirestore.Firestore;
  orderId: string;
  groupId: string;
  adminUid: string;
  expectedGroupRevision: unknown;
  expectedOrderPrivateRevision: unknown;
  courierName: unknown;
  trackingNumber: unknown;
  trackingUrl?: unknown;
}): Promise<FulfilmentMutationResult & { tracking: FulfilmentGroupTracking }> {
  const trackingInput = validateTrackingInput(input);
  const { db, orderId, groupId, adminUid } = input;
  const orderReference = db.collection("orders").doc(orderId);
  const privateReference = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
  return db.runTransaction(async (transaction) => {
    const [orderSnapshot, privateSnapshot] = await transaction.getAll(orderReference, privateReference);
    if (!orderSnapshot.exists) throw new ApiError("Order not found", 404);
    if (!privateSnapshot.exists) throw new ApiError("Fulfilment attribution unavailable for this legacy order", 409);
    const order = orderSnapshot.data() || {};
    assertOrderCanProgressSupplierFulfilment(order.status, order.stockReservationStatus, order.stockRestorationApplied);
    const privateOrder = parseOrderPrivateFulfilment(orderId, privateSnapshot.data());
    const group = privateOrder.fulfilmentGroups.find((candidate) => candidate.groupId === groupId);
    if (!group) throw new ApiError("Fulfilment group not found", 404);
    assertRevisionFence(privateOrder, group, input.expectedOrderPrivateRevision, input.expectedGroupRevision);
    if (group.status !== "shipped") throw new ApiError("Tracking can be corrected only while the fulfilment group is shipped", 409);
    if (!group.tracking) throw new ApiError("Tracking has not been recorded for this fulfilment group", 409);

    const now = new Date().toISOString();
    const tracking: FulfilmentGroupTracking = {
      ...trackingInput,
      recordedAt: now,
      recordedBy: adminUid,
      revision: group.tracking.revision + 1,
    };
    const nextGroup: OrderFulfilmentGroup = {
      ...group,
      revision: group.revision + 1,
      tracking,
      updatedAt: now,
    };
    const groups = replaceGroup(privateOrder.fulfilmentGroups, nextGroup);
    const nextPrivateRevision = privateOrder.revision + 1;
    const trackingEventId = fulfilmentEventId(orderId, groupId, "tracking_corrected", nextGroup.revision);
    transaction.update(privateReference, {
      fulfilmentGroups: groups,
      revision: nextPrivateRevision,
      updatedAt: now,
    });
    transaction.update(orderReference, {
      shipments: projectCustomerShipments(privateOrder, groups),
      supplierFulfilmentUpdatedAt: now,
      supplierFulfilmentUpdatedBy: adminUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(
      db.collection("supplier_operations_audit").doc(trackingEventId),
      {
        eventId: trackingEventId,
        ...buildAudit(
          orderId,
          nextGroup,
          { type: "admin", uid: adminUid },
          "tracking_corrected",
          group.status,
          nextGroup.status,
          null,
          tracking.revision,
          {
            previousCourierName: group.tracking.courierName,
            previousTrackingNumber: group.tracking.trackingNumber,
          },
        ),
      },
    );
    return {
      orderId,
      groupId,
      status: nextGroup.status,
      groupRevision: nextGroup.revision,
      orderPrivateRevision: nextPrivateRevision,
      orderStatus: cleanText(order.status, 30),
      tracking,
    };
  });
}

export function supplierGroupForAccount(
  privateOrder: ParsedOrderPrivateFulfilment,
  supplierAccountId: string,
): OrderFulfilmentGroup | null {
  return privateOrder.fulfilmentGroups.find((group) => (
    group.supplierAccountId === supplierAccountId && group.status !== "unassigned"
  )) || null;
}

export function assertGroupsAllowOrderCancellation(privateOrder: ParsedOrderPrivateFulfilment): void {
  if (privateOrder.fulfilmentGroups.some((group) => ["accepted", "processing", "packed", "shipped", "delivered"].includes(group.status))) {
    throw new ApiError("Order cannot be cancelled after supplier fulfilment has started", 409);
  }
}

export function prepareAdminDelivery(input: {
  privateOrder: ParsedOrderPrivateFulfilment;
  expectedOrderPrivateRevision: unknown;
  expectedGroupRevisions: unknown;
  adminUid: string;
  now: string;
}): { groups: OrderFulfilmentGroup[]; nextRevision: number; audits: Array<{ id: string; data: Record<string, unknown> }> } {
  const { privateOrder } = input;
  if (privateOrder.fulfilmentGroups.length === 0
    || !privateOrder.fulfilmentGroups.every((group) => group.status === "shipped")) {
    throw new ApiError("Order delivery requires every supplier fulfilment group to be shipped", 409);
  }
  if (privateOrder.revision !== positiveRevision(input.expectedOrderPrivateRevision, "Order fulfilment revision")) {
    throw new ApiError("Fulfilment state changed. Refresh and try again.", 409);
  }
  const revisions = input.expectedGroupRevisions && typeof input.expectedGroupRevisions === "object" && !Array.isArray(input.expectedGroupRevisions)
    ? input.expectedGroupRevisions as Record<string, unknown>
    : {};
  for (const group of privateOrder.fulfilmentGroups) {
    if (group.revision !== positiveRevision(revisions[group.groupId], "Fulfilment group revision")) {
      throw new ApiError("Fulfilment state changed. Refresh and try again.", 409);
    }
  }
  const actor: MutationActor = { type: "admin", uid: input.adminUid };
  const groups = privateOrder.fulfilmentGroups.map((group): OrderFulfilmentGroup => ({
    ...group,
    status: "delivered",
    revision: group.revision + 1,
    deliveredAt: input.now,
    updatedAt: input.now,
  }));
  return {
    groups,
    nextRevision: privateOrder.revision + 1,
    audits: groups.map((group) => ({
      id: fulfilmentEventId(privateOrder.orderId, group.groupId, "delivered", group.revision),
      data: buildAudit(privateOrder.orderId, group, actor, "delivered", "shipped", "delivered", null),
    })),
  };
}
