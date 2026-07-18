import { createHash } from "node:crypto";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import { appLogger } from "../api/logging";

const ADMIN_EMAIL = "zyrolkofficial@gmail.com";

interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: "order_confirmation" | "payment_confirmation" | "order_status" | "admin_new_order" | "admin_payment";
}

const clean = (value: unknown, maxLength: number): string => typeof value === "string"
  ? value.trim().replace(/[\u0000-\u001F\u007F]/g, "").slice(0, maxLength)
  : "";
const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character] || character));
const validEmail = (value: unknown): string => {
  const email = clean(value, 160).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email !== "guest@zyro.lk" ? email : "";
};
const money = (value: unknown): string => `LKR ${(Number(value) || 0).toFixed(2)}`;
const notificationId = (eventId: string, orderId: string, kind: string, recipient: string): string => createHash("sha256")
  .update(`${eventId}:${orderId}:${kind}:${recipient}`).digest("hex");

async function queueEmail(eventId: string, orderId: string, message: EmailMessage): Promise<void> {
  const id = notificationId(eventId, orderId, message.kind, message.to);
  await adminDb.runTransaction(async (transaction) => {
    const outboxRef = adminDb.collection("notification_outbox").doc(id);
    const existing = await transaction.get(outboxRef);
    if (existing.exists) return;
    transaction.create(outboxRef, {
      channel: "email",
      kind: message.kind,
      orderId,
      recipientHash: createHash("sha256").update(message.to).digest("hex"),
      status: "handed_off",
      provider: "firebase-trigger-email",
      createdAt: FieldValue.serverTimestamp(),
      handedOffAt: FieldValue.serverTimestamp(),
    });
    transaction.create(adminDb.collection("mail").doc(id), {
      to: [message.to],
      message: { subject: message.subject, text: message.text, html: message.html },
      metadata: { orderId, kind: message.kind, notificationId: id },
    });
  });
}

function customerOrderEmail(order: FirebaseFirestore.DocumentData): EmailMessage | null {
  const to = validEmail(order.customerEmail);
  if (!to) return null;
  const reference = clean(order.orderNumber, 80) || clean(order.id, 80);
  const name = clean(order.customerName, 120) || "Customer";
  const paymentNote = order.paymentMethod === "payhere"
    ? "Your stock is reserved while PayHere payment verification completes."
    : "We will contact you to confirm delivery.";
  return {
    to,
    kind: "order_confirmation",
    subject: `Zyro.lk order ${reference} received`,
    text: `Hello ${name}, we received order ${reference} for ${money(order.totalPrice)}. ${paymentNote}`,
    html: `<p>Hello ${escapeHtml(name)},</p><p>We received order <strong>${escapeHtml(reference)}</strong> for <strong>${escapeHtml(money(order.totalPrice))}</strong>.</p><p>${escapeHtml(paymentNote)}</p>`,
  };
}

function paymentEmail(order: FirebaseFirestore.DocumentData, admin = false): EmailMessage | null {
  const to = admin ? ADMIN_EMAIL : validEmail(order.customerEmail);
  if (!to) return null;
  const reference = clean(order.orderNumber, 80) || clean(order.id, 80);
  const paymentReference = clean(order.paymentReference, 200);
  return {
    to,
    kind: admin ? "admin_payment" : "payment_confirmation",
    subject: `Payment confirmed for ${reference}`,
    text: `Payment of ${money(order.totalPrice)} for order ${reference} has been securely verified.${paymentReference ? ` PayHere reference: ${paymentReference}.` : ""}`,
    html: `<p>Payment of <strong>${escapeHtml(money(order.totalPrice))}</strong> for order <strong>${escapeHtml(reference)}</strong> has been securely verified.</p>${paymentReference ? `<p>PayHere reference: ${escapeHtml(paymentReference)}</p>` : ""}`,
  };
}

function statusEmail(order: FirebaseFirestore.DocumentData): EmailMessage | null {
  const to = validEmail(order.customerEmail);
  if (!to) return null;
  const reference = clean(order.orderNumber, 80) || clean(order.id, 80);
  const status = clean(order.status, 40) || "updated";
  return {
    to,
    kind: "order_status",
    subject: `Order ${reference}: ${status}`,
    text: `Your Zyro.lk order ${reference} is now ${status}. Sign in to My Orders for the latest tracking information.`,
    html: `<p>Your Zyro.lk order <strong>${escapeHtml(reference)}</strong> is now <strong>${escapeHtml(status)}</strong>.</p><p>Sign in to My Orders for the latest tracking information.</p>`,
  };
}

function adminOrderEmail(order: FirebaseFirestore.DocumentData): EmailMessage {
  const reference = clean(order.orderNumber, 80) || clean(order.id, 80);
  return {
    to: ADMIN_EMAIL,
    kind: "admin_new_order",
    subject: `New Zyro.lk order ${reference}`,
    text: `A new ${clean(order.paymentMethod, 40) || "checkout"} order ${reference} was placed for ${money(order.totalPrice)}.`,
    html: `<p>A new <strong>${escapeHtml(clean(order.paymentMethod, 40) || "checkout")}</strong> order <strong>${escapeHtml(reference)}</strong> was placed for <strong>${escapeHtml(money(order.totalPrice))}</strong>.</p>`,
  };
}

export const sendOrderNotifications = onDocumentWritten("orders/{orderId}", async (event) => {
  const before = event.data?.before.exists ? event.data.before.data() : undefined;
  const after = event.data?.after.exists ? event.data.after.data() : undefined;
  if (!after) return;
  const orderId = event.params.orderId;
  const order = { id: orderId, ...after };
  const messages: EmailMessage[] = [];

  if (!before) {
    const customer = customerOrderEmail(order);
    if (customer) messages.push(customer);
    messages.push(adminOrderEmail(order));
  }

  const paymentBecamePaid = before?.paymentStatus !== "paid" && after.paymentStatus === "paid";
  if (paymentBecamePaid) {
    const customer = paymentEmail(order);
    const admin = paymentEmail(order, true);
    if (customer) messages.push(customer);
    if (admin) messages.push(admin);
  }

  if (before && before.status !== after.status && !paymentBecamePaid) {
    const customer = statusEmail(order);
    if (customer) messages.push(customer);
  }

  await Promise.all(messages.map((message) => queueEmail(event.id, orderId, message)));
  if (messages.length) appLogger.info("Order notifications handed off.", { orderId, count: messages.length });
});
