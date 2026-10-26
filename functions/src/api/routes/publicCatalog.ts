import * as express from "express";
import { adminDb } from "../firebase";
import { sendApiError } from "../errors";
import {
  loadPublicCatalogCounts,
  loadPublicHomepageProducts,
  loadPublicProductsByIds,
  listPublicCatalogProducts,
  parsePublicCatalogCategoryIds,
  parsePublicCatalogIds,
} from "../products/publicCatalog";

export function registerPublicCatalogRoutes(app: express.Express): void {
  app.get("/api/catalog/products", async (req, res) => {
    try {
      res.set("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
      res.status(200).json(await listPublicCatalogProducts(adminDb, {
        limit: req.query.limit,
        after: req.query.after,
      }));
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Public catalog page failed.",
        fallbackMessage: "The product catalogue is temporarily unavailable.",
        context: { route: "/api/catalog/products" },
      });
    }
  });

  app.get("/api/catalog/products/homepage", async (_req, res) => {
    try {
      res.set("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
      res.status(200).json({ products: await loadPublicHomepageProducts(adminDb) });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Public homepage catalogue failed.",
        fallbackMessage: "Homepage products are temporarily unavailable.",
        context: { route: "/api/catalog/products/homepage" },
      });
    }
  });

  app.get("/api/catalog/products/by-ids", async (req, res) => {
    try {
      const ids = parsePublicCatalogIds(req.query.ids);
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ products: await loadPublicProductsByIds(adminDb, ids) });
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Public targeted catalogue lookup failed.",
        fallbackMessage: "The requested products are temporarily unavailable.",
        context: { route: "/api/catalog/products/by-ids" },
      });
    }
  });

  app.get("/api/catalog/counts", async (req, res) => {
    try {
      const categoryIds = parsePublicCatalogCategoryIds(req.query.categoryIds);
      res.set("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
      res.status(200).json(await loadPublicCatalogCounts(adminDb, categoryIds));
    } catch (error) {
      sendApiError(res, error, {
        logMessage: "Public catalogue counts failed.",
        fallbackMessage: "Product counts are temporarily unavailable.",
        context: { route: "/api/catalog/counts" },
      });
    }
  });
}
