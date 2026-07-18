import * as express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAdminAuth } from "../middleware/adminAuth";
import { adminAuth, adminDb } from "../firebase";
import { sendApiError } from "../errors";
import { assertCustomerCanCancelOrder, buildOrderStatusPlan } from "../orders/orderStatusLogic";

const ORDER_STATUSES = new Set(["pending", "confirmed", "packed", "shipped", "delivered", "cancelled"]);

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

async function updateOrderStatus(orderId: string, newStatus: string, customerUid?: string) {
  return adminDb.runTransaction(async (transaction) => {
    const orderRef = adminDb.collection("orders").doc(orderId);
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });

    const order = orderSnap.data()!;
    const currentStatus = String(order.status || "pending").toLowerCase();
    if (customerUid) assertCustomerCanCancelOrder(customerUid, order.customerUid, currentStatus);

    const { shouldRestoreStock, quantities } = buildOrderStatusPlan(
      order.status, newStatus, order.stockDeducted, order.stockRestorationApplied, order.items,
    );

    const productStocks: Array<{ ref: FirebaseFirestore.DocumentReference; stock: number; quantity: number }> = [];
    for (const [productId, quantity] of quantities) {
      const productRef = adminDb.collection("products").doc(productId);
      const productSnap = await transaction.get(productRef);
      if (productSnap.exists) {
        const stock = Number(productSnap.data()?.stock);
        productStocks.push({ ref: productRef, stock: Number.isFinite(stock) ? stock : 0, quantity });
      }
    }

    productStocks.forEach(({ ref, stock, quantity }) => transaction.update(ref, { stock: stock + quantity }));
    transaction.update(orderRef, {
      status: newStatus,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      ...(shouldRestoreStock ? {
        stockRestorationApplied: true,
        stockRestoredAt: FieldValue.serverTimestamp(),
      } : {}),
    });

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
    if (!orderId || !ORDER_STATUSES.has(newStatus)) {
      res.status(400).json({ error: "A valid order ID and status are required" });
      return;
    }

    try {
      const result = await updateOrderStatus(orderId, newStatus);

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
