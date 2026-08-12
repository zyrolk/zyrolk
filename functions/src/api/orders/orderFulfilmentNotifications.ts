import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { ORDER_EMAIL_MAX_ATTEMPTS } from "./orderNotificationLogic";

export type FulfilmentEmailKind =
  | "supplier_fulfilment_assigned"
  | "admin_fulfilment_declined"
  | "customer_fulfilment_shipped"
  | "customer_fulfilment_delivered";

export interface FulfilmentNotificationLine {
  productId: string;
  name: string;
  quantity: number;
}

const clean = (value: unknown, maximum: number): string => typeof value === "string"
  ? value.normalize("NFKC").trim().replace(/[\u0000-\u001F\u007F]/gu, "").replace(/\s+/gu, " ").slice(0, maximum)
  : "";

export function projectFulfilmentNotificationLines(
  order: FirebaseFirestore.DocumentData,
  privateOrder: { lines: readonly { lineId: string; productId: string }[] },
  group: { lineIds: readonly string[] },
): FulfilmentNotificationLine[] {
  const productIds = new Set(privateOrder.lines
    .filter((line) => group.lineIds.includes(line.lineId))
    .map((line) => line.productId));
  const items = Array.isArray(order.items) ? order.items : [];
  return items.flatMap((value: unknown): FulfilmentNotificationLine[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const productId = clean(item.productId, 180);
    const quantity = Number(item.quantity);
    if (!productIds.has(productId) || !Number.isInteger(quantity) || quantity < 1) return [];
    return [{
      productId,
      name: clean(item.name, 120) || productId,
      quantity,
    }];
  }).slice(0, 50);
}

export interface TransactionalEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
}

export const escapeNotificationHtml = (value: string): string => value.replace(/[&<>'"]/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character] || character));

export const validNotificationEmail = (value: unknown): string => {
  const email = clean(value, 160).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) && email !== "guest@zyro.lk" ? email : "";
};

export const fulfilmentEmailNotificationsEnabled = (settings: FirebaseFirestore.DocumentData | undefined): boolean => (
  settings?.emailNotificationsEnabled !== false && settings?.orderNotificationsEnabled !== false
);

export const fulfilmentNotificationId = (
  eventId: string,
  orderId: string,
  kind: string,
  recipient: string,
): string => createHash("sha256")
  .update(`${eventId}:${orderId}:${kind}:${recipient.trim().toLowerCase()}`)
  .digest("hex");

export function enqueueTransactionalEmail(
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  eventId: string,
  orderId: string,
  message: TransactionalEmailMessage,
  groupId?: string,
): string | null {
  const recipient = validNotificationEmail(message.to);
  if (!recipient) return null;
  const subject = clean(message.subject, 180);
  const text = clean(message.text, 2_000);
  const html = typeof message.html === "string" ? message.html.slice(0, 6_000) : "";
  if (!subject || !text || !html) return null;
  const id = fulfilmentNotificationId(eventId, orderId, message.kind, recipient);
  transaction.create(db.collection("notification_outbox").doc(id), {
    channel: "email",
    kind: message.kind,
    orderId,
    ...(groupId ? { groupId } : {}),
    eventId,
    recipientHash: createHash("sha256").update(recipient).digest("hex"),
    status: "handed_off",
    provider: "firebase-trigger-email",
    attemptCount: 1,
    maxAttempts: ORDER_EMAIL_MAX_ATTEMPTS,
    currentMailId: id,
    createdAt: FieldValue.serverTimestamp(),
    handedOffAt: FieldValue.serverTimestamp(),
  });
  transaction.create(db.collection("mail").doc(id), {
    to: [recipient],
    message: { subject, text, html },
    metadata: {
      orderId,
      ...(groupId ? { groupId } : {}),
      kind: message.kind,
      notificationId: id,
      deliveryAttempt: 1,
    },
  });
  return id;
}

const lineSummary = (lines: readonly FulfilmentNotificationLine[]): string => {
  const bounded = lines.slice(0, 8).map((line) => `${clean(line.name, 120) || clean(line.productId, 120)} x ${line.quantity}`);
  return `${bounded.join(", ")}${lines.length > bounded.length ? `, plus ${lines.length - bounded.length} more item(s)` : ""}`;
};

export function createSupplierAssignmentNotification(input: {
  transaction: FirebaseFirestore.Transaction;
  db: FirebaseFirestore.Firestore;
  eventId: string;
  orderId: string;
  orderNumber: string;
  groupId: string;
  supplierAccountId: string;
  supplierEmail: unknown;
  lines: readonly FulfilmentNotificationLine[];
  emailEnabled: boolean;
}): void {
  const summary = lineSummary(input.lines);
  const id = fulfilmentNotificationId(input.eventId, input.orderId, "supplier_fulfilment_assigned", input.supplierAccountId);
  input.transaction.create(input.db.collection("supplier_notifications").doc(id), {
    notificationId: id,
    eventId: input.eventId,
    audience: "supplier",
    supplierId: input.supplierAccountId,
    type: "fulfilment_assigned",
    title: "New fulfilment group assigned",
    message: `Order ${input.orderNumber}, group ${input.groupId}: ${summary}. Review the delivery details and accept or decline this group.`,
    orderId: input.orderId,
    groupId: input.groupId,
    lines: input.lines.slice(0, 50),
    isRead: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (!input.emailEnabled) return;
  const escapedOrder = escapeNotificationHtml(input.orderNumber);
  const escapedGroup = escapeNotificationHtml(input.groupId);
  const escapedSummary = escapeNotificationHtml(summary);
  enqueueTransactionalEmail(input.transaction, input.db, input.eventId, input.orderId, {
    to: validNotificationEmail(input.supplierEmail),
    kind: "supplier_fulfilment_assigned",
    subject: `Zyro.lk fulfilment assignment: ${input.orderNumber}`,
    text: `Order ${input.orderNumber}, group ${input.groupId} was assigned to your supplier account. Items: ${summary}. Open Supplier Portal to accept or decline the group.`,
    html: `<p>Order <strong>${escapedOrder}</strong>, group <strong>${escapedGroup}</strong> was assigned to your supplier account.</p><p>Items: ${escapedSummary}</p><p>Open Supplier Portal to accept or decline the group.</p>`,
  }, input.groupId);
}

export function createAdminDeclineNotification(input: {
  transaction: FirebaseFirestore.Transaction;
  db: FirebaseFirestore.Firestore;
  eventId: string;
  orderId: string;
  orderNumber: string;
  groupId: string;
  supplierAccountId: string;
  declineReason: string;
  adminEmail: unknown;
  emailEnabled: boolean;
}): void {
  const reason = clean(input.declineReason, 500) || "No reason supplied.";
  const id = fulfilmentNotificationId(input.eventId, input.orderId, "admin_fulfilment_declined", "admin");
  input.transaction.create(input.db.collection("supplier_notifications").doc(id), {
    notificationId: id,
    eventId: input.eventId,
    audience: "admin",
    type: "fulfilment_declined",
    title: "Supplier fulfilment declined",
    message: `Order ${input.orderNumber}, group ${input.groupId} was declined by supplier ${input.supplierAccountId}. Reason: ${reason} Reassignment is required.`,
    orderId: input.orderId,
    groupId: input.groupId,
    supplierAccountId: input.supplierAccountId,
    declineReason: reason,
    isRead: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (!input.emailEnabled) return;
  enqueueTransactionalEmail(input.transaction, input.db, input.eventId, input.orderId, {
    to: validNotificationEmail(input.adminEmail),
    kind: "admin_fulfilment_declined",
    subject: `Supplier action required for ${input.orderNumber}`,
    text: `Supplier ${input.supplierAccountId} declined group ${input.groupId} for order ${input.orderNumber}. Reason: ${reason} Reassignment is required.`,
    html: `<p>Supplier <strong>${escapeNotificationHtml(input.supplierAccountId)}</strong> declined group <strong>${escapeNotificationHtml(input.groupId)}</strong> for order <strong>${escapeNotificationHtml(input.orderNumber)}</strong>.</p><p>Reason: ${escapeNotificationHtml(reason)}</p><p>Reassignment is required.</p>`,
  }, input.groupId);
}

export function createCustomerShipmentEmail(input: {
  transaction: FirebaseFirestore.Transaction;
  db: FirebaseFirestore.Firestore;
  eventId: string;
  orderId: string;
  orderNumber: string;
  groupId: string;
  customerEmail: unknown;
  courierName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  lines: readonly FulfilmentNotificationLine[];
  emailEnabled: boolean;
}): void {
  if (!input.emailEnabled) return;
  const summary = lineSummary(input.lines);
  const safeUrl = typeof input.trackingUrl === "string" && /^https:\/\//u.test(input.trackingUrl) ? input.trackingUrl : null;
  const urlText = safeUrl ? ` Track securely: ${safeUrl}` : "";
  const urlHtml = safeUrl ? `<p><a href="${escapeNotificationHtml(safeUrl)}">Track package</a></p>` : "";
  enqueueTransactionalEmail(input.transaction, input.db, input.eventId, input.orderId, {
    to: validNotificationEmail(input.customerEmail),
    kind: "customer_fulfilment_shipped",
    subject: `Order ${input.orderNumber}: shipment dispatched`,
    text: `A shipment for order ${input.orderNumber} is on the way. Items: ${summary}. Courier: ${input.courierName}. Tracking number: ${input.trackingNumber}.${urlText} Check My Orders for the latest status.`,
    html: `<p>A shipment for order <strong>${escapeNotificationHtml(input.orderNumber)}</strong> is on the way.</p><p>Items: ${escapeNotificationHtml(summary)}</p><p>Courier: <strong>${escapeNotificationHtml(input.courierName)}</strong><br/>Tracking number: <strong>${escapeNotificationHtml(input.trackingNumber)}</strong></p>${urlHtml}<p>Check My Orders for the latest status.</p>`,
  }, input.groupId);
}

export function createCustomerDeliveryEmail(input: {
  transaction: FirebaseFirestore.Transaction;
  db: FirebaseFirestore.Firestore;
  eventId: string;
  orderId: string;
  orderNumber: string;
  customerEmail: unknown;
  shipmentCount: number;
  lines: readonly FulfilmentNotificationLine[];
  emailEnabled: boolean;
}): void {
  if (!input.emailEnabled) return;
  const summary = lineSummary(input.lines);
  enqueueTransactionalEmail(input.transaction, input.db, input.eventId, input.orderId, {
    to: validNotificationEmail(input.customerEmail),
    kind: "customer_fulfilment_delivered",
    subject: `Order ${input.orderNumber} delivered`,
    text: `Delivery is confirmed for order ${input.orderNumber}. ${input.shipmentCount} shipment(s): ${summary}. Thank you for shopping with Zyro.lk.`,
    html: `<p>Delivery is confirmed for order <strong>${escapeNotificationHtml(input.orderNumber)}</strong>.</p><p>${input.shipmentCount} shipment(s): ${escapeNotificationHtml(summary)}</p><p>Thank you for shopping with Zyro.lk.</p>`,
  });
}
