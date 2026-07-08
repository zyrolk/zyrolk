import * as express from "express";
import { adminDb } from "../firebase";
import { requireAdminAuth } from "../middleware/adminAuth";
import { A2ZConnectorService } from "../suppliers/a2z/A2ZConnectorService";

async function getA2ZCredentials(): Promise<{ username: string; password: string }> {
  let credentials = {
    username: process.env.A2Z_USERNAME || "",
    password: process.env.A2Z_PASSWORD || ""
  };

  try {
    const sourcesSnap = await adminDb.collection("supplierSources").get();
    sourcesSnap.forEach((doc) => {
      const data = doc.data();
      const name = (data.supplierName || data.name || doc.id || "").toLowerCase();
      const url = (data.websiteUrl || data.config?.targetUrl || "").toLowerCase();

      if (name.includes("a2z") || url.includes("a2z") || doc.id.toLowerCase().includes("a2z")) {
        const config = data.config || {};
        const settings = data.settings || {};

        credentials = {
          username: config.username || settings.username || data.username || process.env.A2Z_USERNAME || "",
          password: config.password || settings.password || data.password || process.env.A2Z_PASSWORD || ""
        };
      }
    });
  } catch {
    console.warn("[A2Z-Connector] Could not read supplier credentials from Firestore; using environment variables if configured.");
  }

  if (!credentials.username || !credentials.password) {
    throw new Error("A2Z credentials are not configured. Set A2Z_USERNAME and A2Z_PASSWORD in the server environment or save credentials in supplierSources.");
  }

  return credentials;
}

function buildSupplierTargetUrl(websiteUrl: string, endpoint: string): string {
  let targetUrl = websiteUrl.trim().endsWith("/") ? websiteUrl.trim() : `${websiteUrl.trim()}/`;
  const cleanEndpoint = endpoint.trim();

  if (cleanEndpoint) {
    targetUrl += cleanEndpoint.startsWith("/") ? cleanEndpoint.substring(1) : cleanEndpoint;
  }

  return targetUrl;
}

export function registerSupplierRoutes(app: express.Express): void {
  app.post("/api/test-supplier", requireAdminAuth, async (req, res) => {
    const { websiteUrl, endpoint = "" } = req.body;

    if (!websiteUrl) {
      res.status(400).json({ error: "Website URL is required" });
      return;
    }

    const isA2Z = websiteUrl.toLowerCase().includes("a2z") || endpoint.toLowerCase().includes("a2z");

    if (isA2Z) {
      try {
        console.log("[A2Z-Connector] Triggering secure connection test via A2Z Connector Service...");
        const credentials = await getA2ZCredentials();
        const products = await A2ZConnectorService.fetchCatalog(websiteUrl, credentials);

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

    const targetUrl = buildSupplierTargetUrl(websiteUrl, endpoint);

    try {
      console.log("Testing connection to target URL:", targetUrl);

      let data: any = null;
      let success = false;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const resObj = await fetch(targetUrl, { signal: controller.signal });
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

    const isA2Z = websiteUrl.toLowerCase().includes("a2z") || endpoint.toLowerCase().includes("a2z");

    if (isA2Z) {
      try {
        console.log("[A2Z-Connector] Orchestrating secure, authenticated catalog sync from A2Z Supplier...");
        const credentials = await getA2ZCredentials();
        const products = await A2ZConnectorService.fetchCatalog(websiteUrl, credentials);
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

    const targetUrl = buildSupplierTargetUrl(websiteUrl, endpoint);

    try {
      console.log("Fetching from target URL:", targetUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const resObj = await fetch(targetUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!resObj.ok) {
        throw new Error(`Supplier API returned HTTP ${resObj.status}`);
      }

      const data = await resObj.json();

      if (!Array.isArray(data)) {
        throw new Error("Invalid response format. Expected a JSON array of product objects.");
      }

      res.json({ success: true, products: data });
    } catch (error: any) {
      console.error("Fetch supplier error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to fetch from the supplier endpoint."
      });
    }
  });
}
