import * as express from "express";
import { requireAdminAuth } from "../middleware/adminAuth";
import { getApprovedSupplierHosts, validateSupplierRequestTarget } from "../security/supplierUrlProtection";
import { fetchSupplierProductsFromTarget, getA2ZCredentials } from "../suppliers/fetchSupplierProducts";
import { A2ZConnectorService } from "../suppliers/a2z/A2ZConnectorService";

export function registerSupplierRoutes(app: express.Express): void {
  app.post("/api/test-supplier", requireAdminAuth, async (req, res) => {
    const { websiteUrl, endpoint = "" } = req.body;

    if (!websiteUrl) {
      res.status(400).json({ error: "Website URL is required" });
      return;
    }

    let validatedTarget;
    try {
      validatedTarget = await validateSupplierRequestTarget(websiteUrl, endpoint, await getApprovedSupplierHosts());
    } catch (error: any) {
      res.status(400).json({
        success: false,
        status: "Failed",
        error: error.message || "Supplier URL is not allowed."
      });
      return;
    }

    const isA2Z = validatedTarget.targetUrl.toLowerCase().includes("a2z");

    if (isA2Z) {
      try {
        console.log("[A2Z-Connector] Triggering secure connection test via A2Z Connector Service...");
        const credentials = await getA2ZCredentials();
        const products = await A2ZConnectorService.fetchCatalog(validatedTarget.targetUrl, credentials);

        res.json({
          success: true,
          status: "Connected",
          productsCount: products.length,
          sampleProduct: products[0] || null
        });
        return;
      } catch (error: any) {
        console.error("[A2Z-Connector] Connection test failed:", error);
        res.status(200).json({
          success: false,
          status: "Failed",
          error: error.message || "Authentication or fetch failed with A2Z supplier."
        });
        return;
      }
    }

    try {
      console.log("Testing connection to target URL:", validatedTarget.targetUrl);

      let data: any = null;
      let success = false;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const resObj = await fetch(validatedTarget.targetUrl, { signal: controller.signal, redirect: "error" });
        clearTimeout(timeoutId);

        if (resObj.ok) {
          data = await resObj.json();
          success = true;
        } else {
          console.warn(`External fetch failed with status: ${resObj.status}`);
        }
      } catch (fetchErr: any) {
        console.warn("External fetch failed, trying local fallback:", fetchErr.message || fetchErr);
      }

      if (!success) {
        res.status(200).json({
          success: false,
          status: "Failed",
          error: "Failed to connect to the supplier endpoint. Server returned non-200 status or timed out."
        });
        return;
      }

      const isProductsArray = Array.isArray(data) && (data.length === 0 || (data[0] && (data[0].sku || data[0].title || data[0].name || data[0].id)));

      if (!isProductsArray) {
        res.status(200).json({
          success: false,
          status: "Failed",
          error: "Response format is invalid. Expected a JSON array of product objects."
        });
        return;
      }

      res.json({
        success: true,
        status: "Connected",
        productsCount: data.length,
        sampleProduct: data[0] || null
      });
    } catch (error: any) {
      console.error("Test connection error:", error);
      res.status(200).json({
        success: false,
        status: "Failed",
        error: error.message || "An unexpected network or parsing error occurred."
      });
    }
  });

  app.post("/api/fetch-supplier", requireAdminAuth, async (req, res) => {
    const { websiteUrl, endpoint = "" } = req.body;

    if (!websiteUrl) {
      res.status(400).json({ error: "Website URL is required" });
      return;
    }

    let validatedTarget;
    try {
      validatedTarget = await validateSupplierRequestTarget(websiteUrl, endpoint, await getApprovedSupplierHosts());
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: error.message || "Supplier URL is not allowed."
      });
      return;
    }

    const isA2Z = validatedTarget.targetUrl.toLowerCase().includes("a2z");

    if (isA2Z) {
      try {
        console.log("[A2Z-Connector] Orchestrating secure, authenticated catalog sync from A2Z Supplier...");
        const credentials = await getA2ZCredentials();
        const products = await A2ZConnectorService.fetchCatalog(validatedTarget.targetUrl, credentials);
        res.json({ success: true, products });
        return;
      } catch (error: any) {
        console.error("[A2Z-Connector] Catalog fetch failed:", error);
        res.status(500).json({
          success: false,
          error: error.message || "Failed to authenticate or retrieve from A2Z supplier."
        });
        return;
      }
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
