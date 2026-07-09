import * as express from "express";
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
      res.status(400).json({
        success: false,
        status: "Failed",
        error: error.message || "Supplier URL is not allowed."
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
      console.error("Fetch supplier error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to fetch from the supplier endpoint."
      });
    }
  });
}
