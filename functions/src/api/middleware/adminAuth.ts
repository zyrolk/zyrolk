import * as express from "express";
import { adminAuth, adminDb } from "../firebase";

const ADMIN_EMAIL = "zyrolkofficial@gmail.com";

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

    if (email === ADMIN_EMAIL) {
      next();
      return;
    }

    const userSnap = await adminDb.collection("users").doc(decodedToken.uid).get();
    const userRole = userSnap.exists ? userSnap.data()?.role : null;

    if (userRole === "admin") {
      next();
      return;
    }

    res.status(403).json({ error: "Admin access required" });
  } catch (error) {
    console.warn("[Supplier API] Failed admin authentication:", error);
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
};
