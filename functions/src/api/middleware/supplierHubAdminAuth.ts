import * as express from "express";
import { adminAuth } from "../firebase";
import { appLogger } from "../logging";

export interface SupplierHubAdminIdentity {
  uid: string;
  email: string;
}

/**
 * Supplier Hub administration is intentionally based only on Firebase custom
 * claims. Claims are minted by trusted Firebase Admin tooling and cannot be
 * elevated by a browser write to a user-profile document.
 */
export function hasSupplierHubAdminAccess(claims: Record<string, unknown>): boolean {
  return claims.admin === true || claims.role === "admin" || claims.supplierHubAdmin === true;
}

export const requireSupplierHubAdmin: express.RequestHandler = async (req, res, next) => {
  const authHeader = req.header("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
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
    res.status(401).json({ error: "Invalid, expired, or revoked authentication token" });
  }
};
