import * as express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAdminAuth } from "../middleware/adminAuth";
import { adminAuth, adminDb } from "../firebase";
import { sendApiError } from "../errors";
import {
  ORDER_STATUSES, assertCustomerCanCancelOrder, buildOrderStatusPlan, requireCurrentProductStock,
} from "../orders/orderStatusLogic";
import {
  assertGroupsAllowOrderCancellation,
  fulfilmentEventId,
  ORDER_PRIVATE_COLLECTION,
  parseOrderPrivateFulfilment,
  prepareAdminDelivery,
  projectCustomerShipments,
} from "../orders/orderFulfilmentGroups";
import {
  createCustomerDeliveryEmail,
  fulfilmentEmailNotificationsEnabled,
  projectFulfilmentNotificationLines,
} from "../orders/orderFulfilmentNotifications";
import { appendPaymentTimeline, createPaymentTimelineEvent } from "../payments/payhereLogic";

const VALID_ORDER_STATUSES = new Set<string>(ORDER_STATUSES);

const requireCustomerAuth: express.RequestHandler = async (req, res, next) => {
  const match = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const decodedToken = await adminAuth.verifyIdToken(match[1]);
    res.locals.customerUid = decodedToken.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};

export async function updateOrderStatus(
  orderId: string,
  newStatus: string,
  customerUid?: string,
  db: FirebaseFirestore.Firestore = adminDb,
  revisionFence?: {
    adminUid: string;
    expectedOrderPrivateRevision?: unknown;
    expectedGroupRevisions?: unknown;
  },
) {
  return db.runTransaction(async (transaction) => {
    const orderRef = db.collection("orders").doc(orderId);
    const privateRef = db.collection(ORDER_PRIVATE_COLLECTION).doc(orderId);
    const settingsRef = db.collection("settings").doc("website");
    const [orderSnap, privateSnap, settingsSnap] = await transaction.getAll(orderRef, privateRef, settingsRef);
    if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });

    const order = orderSnap.data()!;
    const currentStatus = String(order.status || "pending").toLowerCase();
    if (customerUid) assertCustomerCanCancelOrder(customerUid, order.customerUid, currentStatus);
    const privateOrder = privateSnap.exists && Array.isArray(privateSnap.data()?.fulfilmentGroups)
      ? parseOrderPrivateFulfilment(orderId, privateSnap.data())
      : null;
    if (newStatus === "cancelled" && privateOrder) assertGroupsAllowOrderCancellation(privateOrder);
    if (privateOrder?.fulfilmentGroups.length
      && ["processing", "packed", "shipped"].includes(newStatus)
      && newStatus !== currentStatus) {
      throw Object.assign(new Error("Supplier-backed order progress is derived from fulfilment groups"), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    const delivery = privateOrder?.fulfilmentGroups.length && newStatus === "delivered" && newStatus !== currentStatus
      ? prepareAdminDelivery({
        privateOrder,
        expectedOrderPrivateRevision: revisionFence?.expectedOrderPrivateRevision,
        expectedGroupRevisions: revisionFence?.expectedGroupRevisions,
        adminUid: revisionFence?.adminUid || "unknown-admin",
        now,
      })
      : null;

    const { shouldRestoreStock, quantities } = buildOrderStatusPlan(
      order.status, newStatus, order.stockDeducted, order.stockRestorationApplied, order.items,
      order.supplierFulfilmentStatus,
    );
    const cancellingUnsettledPayHere = shouldRestoreStock
      && order.paymentMethod === "payhere"
      && new Set(["awaiting_payment", "pending"]).has(String(order.paymentStatus || ""));
    const cancellingPaidPayHere = shouldRestoreStock && order.paymentMethod === "payhere" && order.paymentStatus === "paid";
    const committingOfflineReservation = !shouldRestoreStock
      && order.paymentMethod !== "payhere"
      && order.stockReservationStatus === "reserved"
      && newStatus !== "pending"
      && newStatus !== "cancelled";

    const productStocks: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number; quantity: number }> = [];
    for (const [productId, quantity] of quantities) {
      const productRef = db.collection("products").doc(productId);
      const productSnap = await transaction.get(productRef);
      const stock = requireCurrentProductStock(productSnap.exists, productSnap.data()?.stock);
      productStocks.push({ ref: productRef, stock, quantity });
    }

    productStocks.forEach(({ ref, stock, quantity }) => transaction.update(ref, { stock: stock + quantity }));
    if (delivery) {
      transaction.update(privateRef, {
        fulfilmentGroups: delivery.groups,
        revision: delivery.nextRevision,
        updatedAt: now,
      });
      delivery.audits.forEach((audit) => transaction.create(
        db.collection("supplier_operations_audit").doc(audit.id),
        audit.data,
      ));
      const deliveryEventId = fulfilmentEventId(
        orderId,
        "all-groups",
        "customer_delivered",
        delivery.nextRevision,
      );
      createCustomerDeliveryEmail({
        transaction,
        db,
        eventId: deliveryEventId,
        orderId,
        orderNumber: String(order.orderNumber || orderId),
        customerEmail: order.customerEmail,
        shipmentCount: delivery.groups.filter((group) => group.tracking).length,
        lines: projectFulfilmentNotificationLines(
          order,
          privateOrder!,
          { lineIds: privateOrder!.lines.map((line) => line.lineId) },
        ),
        emailEnabled: fulfilmentEmailNotificationsEnabled(settingsSnap.data()),
      });
    }
    transaction.update(orderRef, {
      status: newStatus,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      ...(delivery ? {
        supplierFulfilmentStatus: "delivered",
        supplierFulfilmentUpdatedAt: now,
        supplierFulfilmentUpdatedBy: revisionFence?.adminUid || "unknown-admin",
        shipments: projectCustomerShipments(privateOrder!, delivery.groups),
      } : {}),
      ...(committingOfflineReservation ? {
        stockReservationStatus: "committed",
        stockReservationExpiresAt: FieldValue.delete(),
        stockReservationCommittedAt: FieldValue.serverTimestamp(),
      } : {}),
      ...(shouldRestoreStock ? {
        stockRestorationApplied: true,
        stockRestoredAt: FieldValue.serverTimestamp(),
        stockReservationStatus: "released",
        stockReservationExpiresAt: FieldValue.delete(),
        ...(cancellingUnsettledPayHere ? {
          paymentStatus: "cancelled",
          paymentTimeline: appendPaymentTimeline(order.paymentTimeline, createPaymentTimelineEvent("cancelled", "Order cancelled and reserved stock released", customerUid ? "customer" : "system")),
        } : {}),
        ...(cancellingPaidPayHere ? {
          paymentReviewRequired: true,
          paymentReviewReason: "cancelled_paid_order",
        } : {}),
      } : {}),
    });
    if (cancellingUnsettledPayHere && typeof order.paymentGatewayOrderId === "string") {
      transaction.set(db.collection("payment_transactions").doc(order.paymentGatewayOrderId), {
        status: "cancelled",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return { status: newStatus, stockRestored: shouldRestoreStock };
  });
}

export function registerOrderRoutes(app: express.Express): void {
  app.post("/api/orders/:orderId/cancel", requireCustomerAuth, async (req, res) => {
    const orderId = String(req.params.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "A valid order ID is required" });
      return;
    }
    try {
      const result = await updateOrderStatus(orderId, "cancelled", res.locals.customerUid);
      res.json({ success: true, ...result });
    } catch (error: any) {
      sendApiError(res, error, {
        logMessage: "Customer order cancellation failed.",
        fallbackMessage: "Failed to cancel order",
        context: { route: "/api/orders/:orderId/cancel", orderId },
      });
    }
  });

  app.post("/api/orders/:orderId/status", requireAdminAuth, async (req, res) => {
    const orderId = String(req.params.orderId || "").trim();
    const newStatus = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
    if (!orderId || !VALID_ORDER_STATUSES.has(newStatus)) {
      res.status(400).json({ error: "A valid order ID and status are required" });
      return;
    }

    try {
      const result = await updateOrderStatus(orderId, newStatus, undefined, adminDb, {
        adminUid: String(res.locals.supplierAdmin?.uid || "unknown-admin"),
        expectedOrderPrivateRevision: req.body?.expectedOrderPrivateRevision,
        expectedGroupRevisions: req.body?.expectedGroupRevisions,
      });

      res.json({ success: true, ...result });
    } catch (error: any) {
      sendApiError(res, error, {
        logMessage: "Order status transaction failed.",
        fallbackMessage: "Failed to update order status",
        context: { route: "/api/orders/:orderId/status", orderId, newStatus },
      });
    }
  });
}
