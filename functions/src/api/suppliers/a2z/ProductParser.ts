import { RawA2ZProduct } from "./types";

export class ProductParser {
  public static parseJsonPayload(rawPayload: string | Record<string, any>): RawA2ZProduct {
    let rawObj: Record<string, any>;

    if (typeof rawPayload === "string") {
      try {
        rawObj = JSON.parse(rawPayload);
      } catch (error) {
        console.warn("[A2Z-Connector] Failed to parse raw JSON feed string.", error);
        throw new Error("Invalid JSON format for product payload ingestion.");
      }
    } else {
      rawObj = rawPayload;
    }

    const sku = String(rawObj.pro_code || rawObj.sku || rawObj.supplier_code || rawObj.pro_id || rawObj.id || "").trim();
    const title = String(rawObj.pro_name || rawObj.title || rawObj.name || rawObj.product_name || "").trim();
    const longDescription = String(rawObj.pro_desc || rawObj.longDescription || rawObj.description || rawObj.details || "").trim();

    let mediaGallery: string[] = [];
    if (Array.isArray(rawObj.mediaGallery)) {
      mediaGallery = rawObj.mediaGallery.map(String);
    } else if (Array.isArray(rawObj.images)) {
      mediaGallery = rawObj.images.map(String);
    } else if (typeof rawObj.imageUrl === "string" && rawObj.imageUrl !== "") {
      mediaGallery = [rawObj.imageUrl];
    } else {
      mediaGallery = ["https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=600"];
    }

    const wholesalePrice = Number(rawObj.wholesale_price || rawObj.wholesalePrice || rawObj.costPrice || rawObj.cost_price || rawObj.supplier_price || 0);
    const recommendedRetailPrice = Number(rawObj.website_price || rawObj.price_min || rawObj.price_max || rawObj.recommendedRetailPrice || rawObj.marketPrice || rawObj.retail_price || rawObj.selling_price || 0);
    const inventoryLevel = Number(rawObj.bal !== undefined && rawObj.bal !== null ? rawObj.bal : (rawObj.inventoryLevel !== undefined ? rawObj.inventoryLevel : (rawObj.stock || rawObj.quantity || 0)));
    const categoryHierarchy = rawObj.cat_name ? [String(rawObj.cat_name)] : (Array.isArray(rawObj.categoryHierarchy) ? rawObj.categoryHierarchy.map(String) : []);
    const specifications = typeof rawObj.specifications === "object" && rawObj.specifications !== null ? rawObj.specifications : {};

    return {
      sku,
      title,
      longDescription,
      mediaGallery,
      wholesalePrice,
      recommendedRetailPrice,
      inventoryLevel,
      categoryHierarchy,
      specifications
    };
  }
}
