import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomerShipmentEmail,
  fulfilmentNotificationId,
  GUEST_ORDER_UPDATE_GUIDANCE,
  orderHasCustomerAccount,
} from "../functions/src/api/orders/orderFulfilmentNotifications";
import { ORDER_EMAIL_MAX_ATTEMPTS } from "../functions/src/api/orders/orderNotificationLogic";
import { statusEmail } from "../functions/src/triggers/orderNotifications";

const MY_ORDERS_OR_SIGN_IN = /My Orders|sign in/iu;
const CUSTOMER_EMAIL = "p13c-customer@example.test";

interface CapturedCreate {
  path: string;
  data: Record<string, unknown>;
}

function createCapturingStore() {
  const creates: CapturedCreate[] = [];
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `${name}/${id}` }),
    }),
  } as unknown as FirebaseFirestore.Firestore;
  const transaction = {
    create: (reference: { path: string }, data: Record<string, unknown>) => {
      creates.push({ path: reference.path, data });
    },
  } as unknown as FirebaseFirestore.Transaction;
  return { creates, db, transaction };
}

function shipmentEmail(customerHasAccount: boolean, trackingUrl: string | null = "https://courier.example.test/track/LK-P13C-001") {
  const store = createCapturingStore();
  createCustomerShipmentEmail({
    transaction: store.transaction,
    db: store.db,
    eventId: "p13c-tracking-event",
    orderId: "p13c-order",
    orderNumber: "ZY900001",
    groupId: "p13c-group",
    customerEmail: CUSTOMER_EMAIL,
    customerHasAccount,
    courierName: "P13C Courier",
    trackingNumber: "LK-P13C-001",
    trackingUrl,
    lines: [{ productId: "p13c-product", name: "Customer Product", quantity: 2 }],
    emailEnabled: true,
  });
  const outbox = store.creates.find((entry) => entry.path.startsWith("notification_outbox/"));
  const mail = store.creates.find((entry) => entry.path.startsWith("mail/"));
  assert.ok(outbox && mail, "shipment email must create one outbox record and one mail document");
  assert.equal(store.creates.length, 2);
  return { outbox, mail };
}

const statusOrder = (customerUid: unknown) => ({
  id: "p13c-order",
  orderNumber: "ZY900001",
  status: "packed",
  customerEmail: CUSTOMER_EMAIL,
  customerUid,
});

test("P1-3C account detection treats only real customer UIDs as signed-in", () => {
  assert.equal(orderHasCustomerAccount({ customerUid: "firebase-uid-123" }), true);
  assert.equal(orderHasCustomerAccount({ customerUid: "guest" }), false);
  assert.equal(orderHasCustomerAccount({ customerUid: "  " }), false);
  assert.equal(orderHasCustomerAccount({}), false);
  assert.equal(orderHasCustomerAccount(undefined), false);
});

test("P1-3C A: signed-in customer status email keeps My Orders guidance", () => {
  const email = statusEmail(statusOrder("firebase-uid-123"))!;
  assert.match(email.text, /Sign in to My Orders for the latest tracking information\./u);
  assert.match(email.html, /<p>Sign in to My Orders for the latest tracking information\.<\/p>/u);
  assert.doesNotMatch(email.text, /contact Zyro\.lk customer support/u);
});

test("P1-3C B: guest status email references Order Number and support instead of My Orders", () => {
  for (const customerUid of ["guest", undefined, ""]) {
    const email = statusEmail(statusOrder(customerUid))!;
    assert.doesNotMatch(email.text, MY_ORDERS_OR_SIGN_IN);
    assert.doesNotMatch(email.html, MY_ORDERS_OR_SIGN_IN);
    assert.equal(email.text, `Your Zyro.lk order ZY900001 is now packed. ${GUEST_ORDER_UPDATE_GUIDANCE}`);
    assert.match(email.html, /Keep your Order Number for reference\. For order updates or tracking help, contact Zyro\.lk customer support\./u);
    assert.match(email.html, /<strong>ZY900001<\/strong>/u);
  }
});

test("P1-3C C: signed-in shipped email keeps My Orders guidance", () => {
  const { mail } = shipmentEmail(true);
  const message = mail.data.message as { text: string; html: string };
  assert.match(message.text, /Check My Orders for the latest status\.$/u);
  assert.match(message.html, /<p>Check My Orders for the latest status\.<\/p>$/u);
});

test("P1-3C D: guest shipped email does not reference My Orders or sign-in", () => {
  const { mail } = shipmentEmail(false);
  const message = mail.data.message as { subject: string; text: string; html: string };
  assert.doesNotMatch(message.text, MY_ORDERS_OR_SIGN_IN);
  assert.doesNotMatch(message.html, MY_ORDERS_OR_SIGN_IN);
  assert.ok(message.text.endsWith(GUEST_ORDER_UPDATE_GUIDANCE));
  assert.match(message.html, new RegExp(`<p>${GUEST_ORDER_UPDATE_GUIDANCE.replace(/\./gu, "\\.")}</p>$`, "u"));
});

test("P1-3C E: tracking number and link remain present for signed-in and guest shipped emails", () => {
  for (const customerHasAccount of [true, false]) {
    const { mail } = shipmentEmail(customerHasAccount);
    const message = mail.data.message as { text: string; html: string };
    assert.match(message.text, /Courier: P13C Courier\. Tracking number: LK-P13C-001\./u);
    assert.match(message.text, /Track securely: https:\/\/courier\.example\.test\/track\/LK-P13C-001/u);
    assert.match(message.html, /Tracking number: <strong>LK-P13C-001<\/strong>/u);
    assert.match(message.html, /<a href="https:\/\/courier\.example\.test\/track\/LK-P13C-001">Track package<\/a>/u);
    assert.doesNotMatch(JSON.stringify(mail.data), /purchaseSupplierCost|supplierAccountId|supplierSourceId|supplierOfferId|supplierItemCode/u);
  }
  const withoutLink = shipmentEmail(false, null).mail.data.message as { text: string; html: string };
  assert.match(withoutLink.text, /Tracking number: LK-P13C-001\./u);
  assert.doesNotMatch(withoutLink.text, /Track securely/u);
  assert.doesNotMatch(withoutLink.html, /Track package/u);
});

test("P1-3C F: recipient, subject, notification ID and payload schema are unchanged", () => {
  const expectedId = fulfilmentNotificationId("p13c-tracking-event", "p13c-order", "customer_fulfilment_shipped", CUSTOMER_EMAIL);
  for (const customerHasAccount of [true, false]) {
    const { outbox, mail } = shipmentEmail(customerHasAccount);
    assert.equal(outbox.path, `notification_outbox/${expectedId}`);
    assert.equal(mail.path, `mail/${expectedId}`);
    assert.deepEqual(Object.keys(mail.data).sort(), ["message", "metadata", "to"]);
    assert.deepEqual(mail.data.to, [CUSTOMER_EMAIL]);
    const message = mail.data.message as Record<string, unknown>;
    assert.deepEqual(Object.keys(message).sort(), ["html", "subject", "text"]);
    assert.equal(message.subject, "Order ZY900001: shipment dispatched");
    assert.deepEqual(mail.data.metadata, {
      orderId: "p13c-order",
      groupId: "p13c-group",
      kind: "customer_fulfilment_shipped",
      notificationId: expectedId,
      deliveryAttempt: 1,
    });
    assert.deepEqual(Object.keys(outbox.data).sort(), [
      "attemptCount", "channel", "createdAt", "currentMailId", "eventId", "groupId", "handedOffAt",
      "kind", "maxAttempts", "orderId", "provider", "recipientHash", "status",
    ]);
    assert.equal(outbox.data.status, "handed_off");
    assert.equal(outbox.data.provider, "firebase-trigger-email");
    assert.equal(outbox.data.attemptCount, 1);
    assert.equal(outbox.data.maxAttempts, ORDER_EMAIL_MAX_ATTEMPTS);
    assert.equal(outbox.data.currentMailId, expectedId);
  }

  const signedIn = statusEmail(statusOrder("firebase-uid-123"))!;
  const guest = statusEmail(statusOrder("guest"))!;
  for (const email of [signedIn, guest]) {
    assert.deepEqual(Object.keys(email).sort(), ["html", "kind", "subject", "text", "to"]);
    assert.equal(email.to, CUSTOMER_EMAIL);
    assert.equal(email.kind, "order_status");
    assert.equal(email.subject, "Order ZY900001: packed");
  }
});
