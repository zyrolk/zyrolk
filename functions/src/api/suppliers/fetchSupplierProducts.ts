import { adminDb } from "../firebase";
import { getApprovedSupplierHosts, validateSupplierRequestTarget } from "../security/supplierUrlProtection";
import { A2ZConnectorService } from "./a2z/A2ZConnectorService";

export async function getA2ZCredentials(): Promise<{ username: string; password: string }> {
  let credentials = {
    username: process.env.A2Z_USERNAME || "",
    password: process.env.A2Z_PASSWORD || "",
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
          password: config.password || settings.password || data.password || process.env.A2Z_PASSWORD || "",
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

export async function fetchSupplierProductsFromTarget(
  websiteUrl: string,
  endpoint = "",
): Promise<{ products: any[]; targetUrl: string }> {
  const validatedTarget = await validateSupplierRequestTarget(
    websiteUrl,
    endpoint,
    await getApprovedSupplierHosts(),
  );

  const isA2Z = validatedTarget.targetUrl.toLowerCase().includes("a2z");

  if (isA2Z) {
    console.log("[A2Z-Connector] Orchestrating secure, authenticated catalog sync from A2Z Supplier...");
    const credentials = await getA2ZCredentials();
    const products = await A2ZConnectorService.fetchCatalog(validatedTarget.targetUrl, credentials);
    return { products, targetUrl: validatedTarget.targetUrl };
  }

  console.log("Fetching from target URL:", validatedTarget.targetUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const resObj = await fetch(validatedTarget.targetUrl, {
      signal: controller.signal,
      redirect: "error",
    });

    if (!resObj.ok) {
      throw new Error(`Supplier API returned HTTP ${resObj.status}`);
    }

    const data = await resObj.json();

    if (!Array.isArray(data)) {
      throw new Error("Invalid response format. Expected a JSON array of product objects.");
    }

    return { products: data, targetUrl: validatedTarget.targetUrl };
  } finally {
    clearTimeout(timeoutId);
  }
}
