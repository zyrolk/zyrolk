import * as express from "express";
import { registerCheckoutRoutes } from "./routes/checkout";
import { registerSupplierRoutes } from "./routes/supplier";

export function createApiApp(): express.Express {
  const app = express();

  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
