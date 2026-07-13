import { adminDb } from "../firebase";
import { getA2ZSecretValues } from "../../config/secrets";

export async function getA2ZCredentials(): Promise<{ username: string; password: string }> {
  const runtimeSecrets = getA2ZSecretValues();
  let credentials = { ...runtimeSecrets };

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
          username: config.username || settings.username || data.username || runtimeSecrets.username,
          password: config.password || settings.password || data.password || runtimeSecrets.password,
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
