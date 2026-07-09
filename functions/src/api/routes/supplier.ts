import * as express from "express";
import { sendSupplierFailure } from "../errors";
import { requireAdminAuth } from "../middleware/adminAuth";
import { fetchSupplierProductsFromTarget } from "../suppliers/fetchSupplierProducts";
import { SupplierRegistry } from "../suppliers/SupplierRegistry";

export function registerSupplierRoutes(app: express.Express): void {
  app.post("/api/test-supplier", requireAdminAuth, async (req, res) => {
    const { websiteUrl, endpoint = "" } = req.body;

    if (!websiteUrl) {
      res.status(400).json({ error: "Website URL is required" });
      return;
    }

    try {
      const connector = await SupplierRegistry.createConnectorForTarget(websiteUrl, endpoint);
      const result = await connector.testConnection();

      res.status(200).json(result);
    } catch (error: any) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier connection test failed.",
        fallbackMessage: "Supplier URL is not allowed.",
        fallbackStatusCode: 400,
        includeStatus: true,
        context: {
          route: "/api/test-supplier",
          websiteUrl,
          endpoint,
        },
      });
    }
  });

  app.post("/api/fetch-supplier", requireAdminAuth, async (req, res) => {
    const { websiteUrl, endpoint = "" } = req.body;

    if (!websiteUrl) {
      res.status(400).json({ error: "Website URL is required" });
      return;
    }

    try {
      const result = await fetchSupplierProductsFromTarget(websiteUrl, endpoint);
      res.json({ success: true, products: result.products });
    } catch (error: any) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier catalog fetch failed.",
        fallbackMessage: "Failed to fetch from the supplier endpoint.",
        context: {
          route: "/api/fetch-supplier",
          websiteUrl,
          endpoint,
        },
      });
    }
  });
}
