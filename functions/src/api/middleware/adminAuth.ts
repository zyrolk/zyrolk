import * as express from "express";
import { getRuntimeConfig } from "../config";
import { adminAuth, adminDb } from "../firebase";
import { appLogger } from "../logging";

export function hasSupplierAdminAccess(email: string | undefined, userRole: unknown): boolean {
  return (email || "").toLowerCase() === getRuntimeConfig().adminEmail || userRole === "admin";
}

export const requireAdminAuth: express.RequestHandler = async (req, res, next) => {
  const authHeader = req.header("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(match[1]);
    const email = (decodedToken.email || "").toLowerCase();

    if (hasSupplierAdminAccess(email, null)) {
      next();
      return;
    }

    const userSnap = await adminDb.collection("users").doc(decodedToken.uid).get();
    const userRole = userSnap.exists ? userSnap.data()?.role : null;

    if (hasSupplierAdminAccess(email, userRole)) {
      next();
      return;
    }

    res.status(403).json({ error: "Admin access required" });
  } catch (error) {
    appLogger.warn("Supplier API admin authentication failed.", {
      path: req.path,
      method: req.method,
      error,
    });
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};
