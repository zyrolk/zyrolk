import { adminDb } from "../firebase";
import { getA2ZSecretValues } from "../../config/secrets";
import { A2ZCredentialCandidate, resolveA2ZCredentials } from "./credentialSelection";
import { fingerprintA2ZCredentials } from "./a2z/credentialForensics";

export async function getA2ZCredentials(): Promise<{ username: string; password: string }> {
  const runtimeSecrets = getA2ZSecretValues();
  const legacyCandidates: A2ZCredentialCandidate[] = [];

  try {
    const sourcesSnap = await adminDb.collection("supplierSources").get();
    sourcesSnap.forEach((doc) => {
      const data = doc.data();
      const name = (data.supplierName || data.name || doc.id || "").toLowerCase();
      const url = (data.websiteUrl || data.config?.targetUrl || "").toLowerCase();

      if (name.includes("a2z") || url.includes("a2z") || doc.id.toLowerCase().includes("a2z")) {
        const config = data.config || {};
        const settings = data.settings || {};

        legacyCandidates.push({
          username: config.username || settings.username || data.username || "",
          password: config.password || settings.password || data.password || "",
          source: `firestore:${doc.id}`,
        });
      }
    });
  } catch {
    console.warn("[A2Z-Connector] Could not read supplier credentials from Firestore; using environment variables if configured.");
  }

  const credentials = resolveA2ZCredentials(runtimeSecrets, legacyCandidates);

  const credentialForensics = credentials
    ? fingerprintA2ZCredentials(credentials.username, credentials.password)
    : {};

  if (process.env.SUPPLIER_DEBUG_LOGS === "true") {
    console.info("[A2Z-Connector]", JSON.stringify({
      event: "a2z_credentials_resolved",
      authenticationStage: "credential-selection",
      credentialSource: credentials?.source || "none",
      usernamePresent: Boolean(credentials?.username),
      passwordPresent: Boolean(credentials?.password),
      ...credentialForensics,
    }));
  }

  if (!credentials) {
    throw new Error("A2Z credentials are not configured. Set A2Z_USERNAME and A2Z_PASSWORD in the server environment or save credentials in supplierSources.");
  }

  return { username: credentials.username, password: credentials.password };
}
