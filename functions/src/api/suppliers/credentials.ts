import { getA2ZSecretValues } from "../../config/secrets";
import {
  resolveA2ZCredentialProfile,
} from "./a2zCredentialProfiles";

export interface A2ZCredentialResolutionRequest {
  credentialReference: string;
  targetUrl: string;
  supplierId?: string;
  sourceId?: string;
}

/**
 * Credentials are bound to Functions through Firebase Secret Manager. Supplier
 * documents may describe a secret reference, but never contain a credential
 * value or a Firestore fallback.
 */
export async function getA2ZCredentials(
  request: A2ZCredentialResolutionRequest,
): Promise<{ username: string; password: string }> {
  const resolved = resolveA2ZCredentialProfile(
    getA2ZSecretValues(),
    request.credentialReference,
    request.targetUrl,
  );

  if (process.env.SUPPLIER_DEBUG_LOGS === "true") {
    console.info("[A2Z-Connector]", JSON.stringify({
      event: "a2z_credentials_resolved",
      authenticationStage: "credential-selection",
      credentialSource: "secret-manager-profile",
      profileId: resolved.profileId,
      supplierId: String(request.supplierId || "").slice(0, 160),
      sourceId: String(request.sourceId || "").slice(0, 160),
    }));
  }

  return { username: resolved.username, password: resolved.password };
}
