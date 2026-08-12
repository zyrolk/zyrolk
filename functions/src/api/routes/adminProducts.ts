import * as express from "express";
import { sendApiError } from "../errors";
import { adminDb } from "../firebase";
import { requireAdminAuth } from "../middleware/adminAuth";
import {
  archiveAdminProduct,
  createAdminProduct,
  updateAdminProduct,
} from "../products/adminProductManagement";

const actorFromResponse = (res: express.Response): { uid: string; email: string } => ({
  uid: String(res.locals.supplierAdmin?.uid || "").slice(0, 160),
  email: String(res.locals.supplierAdmin?.email || "unknown").slice(0, 320),
});

export function registerAdminProductRoutes(app: express.Express): void {
  app.post("/api/admin/products", requireAdminAuth, async (req, res) => {
    try {
      const result = await createAdminProduct(
        adminDb,
        actorFromResponse(res),
        req.header("Idempotency-Key"),
        req.body?.draft,
      );
      res.status(result.idempotent ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin product creation failed.",
        fallbackMessage: "Product creation failed.",
        context: { route: "/api/admin/products" },
      });
    }
  });

  app.patch("/api/admin/products/:productId", requireAdminAuth, async (req, res) => {
    try {
      const result = await updateAdminProduct(
        adminDb,
        req.params.productId,
        actorFromResponse(res),
        req.body?.draft,
      );
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin product update failed.",
        fallbackMessage: "Product update failed.",
        context: { route: "/api/admin/products/:productId", productId: req.params.productId },
      });
    }
  });

  app.post("/api/admin/products/:productId/archive", requireAdminAuth, async (req, res) => {
    try {
      const result = await archiveAdminProduct(adminDb, req.params.productId, actorFromResponse(res));
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Admin product archival failed.",
        fallbackMessage: "Product archival failed.",
        context: { route: "/api/admin/products/:productId/archive", productId: req.params.productId },
      });
    }
  });
}
