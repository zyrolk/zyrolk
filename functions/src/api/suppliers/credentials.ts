import { getA2ZSecretValues } from "../../config/secrets";
import { fingerprintA2ZCredentials } from "./a2z/credentialForensics";

/**
 * Credentials are bound to Functions through Firebase Secret Manager. Supplier
 * documents may describe a secret reference, but never contain a credential
 * value or a Firestore fallback.
 */
export async function getA2ZCredentials(_supplierId?: string): Promise<{ username: string; password: string }> {
  const runtimeSecrets = getA2ZSecretValues();
  const credentials = runtimeSecrets.username && runtimeSecrets.password
    ? runtimeSecrets
    : null;
  const credentialForensics = credentials
    ? fingerprintA2ZCredentials(credentials.username, credentials.password)
    : {};

  if (process.env.SUPPLIER_DEBUG_LOGS === "true") {
    console.info("[A2Z-Connector]", JSON.stringify({
      event: "a2z_credentials_resolved",
      authenticationStage: "credential-selection",
      credentialSource: credentials ? "secret-manager" : "none",
      usernamePresent: Boolean(credentials?.username),
      passwordPresent: Boolean(credentials?.password),
      ...credentialForensics,
    }));
  }

  if (!credentials) {
    throw new Error("A2Z credentials are not configured in Firebase Secret Manager.");
  }

  return { username: credentials.username, password: credentials.password };
}
