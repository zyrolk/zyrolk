import * as express from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAdminAuth } from "../middleware/adminAuth";
import { adminDb } from "../firebase";
import { sendApiError } from "../errors";
import { buildOrderStatusPlan } from "../orders/orderStatusLogic";

const ORDER_STATUSES = new Set(["pending", "confirmed", "packed", "shipped", "delivered", "cancelled"]);

export function registerOrderRoutes(app: express.Express): void {
  app.post("/api/orders/:orderId/status", requireAdminAuth, async (req, res) => {
    const orderId = String(req.params.orderId || "").trim();
    const newStatus = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
    if (!orderId || !ORDER_STATUSES.has(newStatus)) {
      res.status(400).json({ error: "A valid order ID and status are required" });
      return;
    }

    try {
      const result = await adminDb.runTransaction(async (transaction) => {
        const orderRef = adminDb.collection("orders").doc(orderId);
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });

        const order = orderSnap.data()!;
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
