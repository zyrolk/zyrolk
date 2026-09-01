import { RawA2ZProduct } from "./a2z/types";

const COST_PRESENCE_FIELDS = new Set(["costPrice", "wholesalePrice"]);
const STOCK_PRESENCE_FIELDS = new Set(["stock", "inventoryLevel"]);

export interface SupplierCommerceAvailability {
  supplierCostAvailable: boolean;
  supplierStockAvailable: boolean;
}

export function supplierCostWasProvided(
  product: Pick<RawA2ZProduct, "providedFields">,
): boolean {
  const providedFields = new Set(product.providedFields || []);
  return [...COST_PRESENCE_FIELDS].some((field) => providedFields.has(field));
}

export function supplierStockWasProvided(
  product: Pick<RawA2ZProduct, "providedFields">,
): boolean {
  const providedFields = new Set(product.providedFields || []);
  return [...STOCK_PRESENCE_FIELDS].some((field) => providedFields.has(field));
}

export function buildSupplierCommerceAvailability(
  product: Pick<RawA2ZProduct, "providedFields">,
): SupplierCommerceAvailability {
  return {
    supplierCostAvailable: supplierCostWasProvided(product),
    supplierStockAvailable: supplierStockWasProvided(product),
  };
}

export function readSupplierCommerceAvailability(
  metadata: Record<string, unknown> | undefined | null,
  providedFields: readonly string[] | undefined,
): SupplierCommerceAvailability {
  const record = metadata && typeof metadata === "object" ? metadata : {};
  if (typeof record.supplierCostAvailable === "boolean"
    && typeof record.supplierStockAvailable === "boolean") {
    return {
      supplierCostAvailable: record.supplierCostAvailable,
      supplierStockAvailable: record.supplierStockAvailable,
    };
  }
  return buildSupplierCommerceAvailability({ providedFields: [...(providedFields || [])] });
}
