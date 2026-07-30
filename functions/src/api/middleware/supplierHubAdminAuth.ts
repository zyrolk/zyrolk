import * as express from "express";
import { adminAuth } from "../firebase";
import { appLogger } from "../logging";
import { recordSupplierOperationalAlertSafely } from "../suppliers/supplierOperationalAlerts";
import { hasSupplierHubAdminAccess } from "../security/adminAuthorization";

export { hasSupplierHubAdminAccess } from "../security/adminAuthorization";

export interface SupplierHubAdminIdentity {
  uid: string;
  email: string;
}

/**
 * Supplier Hub administration is intentionally based only on Firebase custom
 * claims. Claims are minted by trusted Firebase Admin tooling and cannot be
 * elevated by a browser write to a user-profile document.
 */
export const requireSupplierHubAdmin: express.RequestHandler = async (req, res, next) => {
  const authHeader = req.header("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    await recordSupplierOperationalAlertSafely({
      category: "authentication_failure",
      severity: "critical",
      dedupeScope: "supplier-hub-authentication",
      technicalMetadata: { path: req.path, method: req.method, reason: "missing_bearer_token" },
    });
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    // Local Express has no Application Default Credentials for the
    // credential-backed revocation lookup. The marker is set only by server.ts
    // for exact loopback requests. Firebase Functions never set it and always
    // retain revocation-aware verification for privileged endpoints.
    const decodedToken = res.locals.supplierHubLocalExpressPreview === true
      ? await adminAuth.verifyIdToken(match[1])
      : await adminAuth.verifyIdToken(match[1], true);
    if (!hasSupplierHubAdminAccess(decodedToken)) {
      await recordSupplierOperationalAlertSafely({
        category: "authentication_failure",
        severity: "critical",
        dedupeScope: "supplier-hub-authentication",
        technicalMetadata: { path: req.path, method: req.method, reason: "admin_claim_required", uid: decodedToken.uid },
      });
      res.status(403).json({ error: "Supplier Hub administrator access required" });
      return;
    }
    res.locals.supplierAdmin = {
      uid: decodedToken.uid,
      email: (decodedToken.email || "unknown").toLowerCase(),
    } satisfies SupplierHubAdminIdentity;
    next();
  } catch (error) {
    appLogger.warn("Supplier Hub API authentication failed.", {
      path: req.path,
      method: req.method,
      error,
    });
    await recordSupplierOperationalAlertSafely({
      category: "authentication_failure",
      severity: "critical",
      dedupeScope: "supplier-hub-authentication",
      technicalMetadata: { path: req.path, method: req.method, reason: "id_token_verification_failed", error },
    });
    res.status(401).json({ error: "Invalid, expired, or revoked authentication token" });
  }
};
