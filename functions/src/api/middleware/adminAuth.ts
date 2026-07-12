import * as express from "express";
import { getRuntimeConfig } from "../config";
import { adminAuth } from "../firebase";
import { appLogger } from "../logging";

export function hasSupplierAdminAccess(email: string | undefined): boolean {
  return (email || "").toLowerCase() === getRuntimeConfig().adminEmail;
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

    if (hasSupplierAdminAccess(email)) {
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
