import * as express from "express";
import { getRuntimeConfig } from "./config";
import { registerCheckoutRoutes } from "./routes/checkout";
import { registerSupplierRoutes } from "./routes/supplier";

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

    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.set("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    next();
  });

  app.use(express.json());

  registerCheckoutRoutes(app);
  registerSupplierRoutes(app);

  return app;
}
