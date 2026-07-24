import * as express from "express";
import { getRuntimeConfig } from "./config";
import { registerCheckoutRoutes } from "./routes/checkout";
import { registerSupplierRoutes } from "./routes/supplier";
import { registerSupplierPortalRoutes } from "./routes/supplierPortal";
import { registerOrderRoutes } from "./routes/orders";
import { registerReviewSystemRoutes } from "./routes/reviewSystem";
import { registerAdminConfigurationRoutes } from "./routes/adminConfiguration";
import { adminAppCheck, adminAuth, adminDb } from "./firebase";
import { appLogger } from "./logging";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://www.google.com https://www.gstatic.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com https://*.googletagmanager.com https://*.google-analytics.com https://*.firebaseio.com wss://*.firebaseio.com",
  "frame-src https://www.google.com https://www.gstatic.com",
  "upgrade-insecure-requests",
].join("; ");

const xmlEscape = (value: string): string => value.replace(/[<>&'\"]/g, (character) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
}[character] || character));

const isExactLocalhost = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
    || /^localhost:\d+$/u.test(host)
    || /^127\.0\.0\.1:\d+$/u.test(host)
    || /^\[::1\](?::\d+)?$/u.test(host);
};

export function createApiApp(): express.Express {
  const app = express();
  const runtimeConfig = getRuntimeConfig();

  app.use((req, res, next) => {
    const requestOrigin = req.header("Origin") || "";
    const allowedOrigin = runtimeConfig.corsAllowsAllOrigins
      ? "*"
      : runtimeConfig.allowedOrigins.find((origin) => origin === requestOrigin);

    if (allowedOrigin) {
      res.set("Access-Control-Allow-Origin", allowedOrigin);
    }

    if (allowedOrigin && allowedOrigin !== "*") {
      res.set("Vary", "Origin");
    }

    if (requestOrigin && !runtimeConfig.corsAllowsAllOrigins && !allowedOrigin) {
      res.status(403).json({ error: "Origin is not allowed" });
      return;
    }

    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Firebase-AppCheck");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.set("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    next();
  });

  app.use(async (req, res, next) => {
    // Functions only bypass App Check when running in the Firebase emulator and
    // serving an exact loopback host. Deployed Functions always verify tokens.
    const isFunctionsEmulatorRequest = process.env.FUNCTIONS_EMULATOR === "true" && isExactLocalhost(req.hostname || "");
    if (isFunctionsEmulatorRequest || !runtimeConfig.requireAppCheck || req.path === "/sitemap.xml") {
      next();
      return;
    }
    const token = req.header("X-Firebase-AppCheck");
    if (!token) {
      res.status(401).json({ error: "App verification is required" });
      return;
    }
    try {
      await adminAppCheck.verifyToken(token);
      next();
    } catch {
      res.status(401).json({ error: "App verification failed" });
    }
  });

  app.use(express.json({ limit: "100kb" }));

  // PayHere routes deliberately remain unregistered during the COD-only launch period.
  registerAdminConfigurationRoutes(app, { auth: adminAuth });
  registerCheckoutRoutes(app);
  registerOrderRoutes(app);
  registerReviewSystemRoutes(app, {
    db: adminDb,
    verifyIdToken: (token) => adminAuth.verifyIdToken(token),
    isAdminEmail: (email) => (email || "").toLowerCase() === runtimeConfig.adminEmail,
  });
  registerSupplierRoutes(app);
  registerSupplierPortalRoutes(app, { db: adminDb, auth: adminAuth });

  app.post("/api/monitoring/client-error", (req, res) => {
    const context = typeof req.body?.context === "string" ? req.body.context.trim().slice(0, 100) : "client-error";
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "Error";
    const code = typeof req.body?.code === "string" ? req.body.code.trim().slice(0, 80) : "";
    appLogger.warn("Storefront client exception.", { context, name, code });
    res.status(202).json({ accepted: true });
  });

  app.get("/sitemap.xml", async (_req, res) => {
    try {
      const productsSnapshot = await adminDb.collection("products").limit(5000).get();
      const productUrls = productsSnapshot.docs.filter((product) => product.data().isActive !== false).map((product) => (
        `<url><loc>${xmlEscape(`https://zyro.lk/?product=${encodeURIComponent(product.id)}`)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`
      ));
      const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://zyro.lk/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>${productUrls.join("")}</urlset>`;
      res.set("Content-Type", "application/xml; charset=utf-8");
      res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
      res.status(200).send(body);
    } catch (error) {
      appLogger.error("Dynamic sitemap generation failed.", { error });
      res.status(503).type("text/plain").send("Sitemap temporarily unavailable");
    }
  });

  return app;
}
