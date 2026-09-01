export interface SupplierCommerceAvailability {
  supplierCostAvailable: boolean;
  supplierStockAvailable: boolean;
}

const COST_PRESENCE_FIELDS = new Set(["costPrice", "wholesalePrice"]);
const STOCK_PRESENCE_FIELDS = new Set(["stock", "inventoryLevel"]);

export function supplierCostWasProvided(providedFields: readonly string[] | undefined): boolean {
  const fields = new Set(providedFields || []);
  return [...COST_PRESENCE_FIELDS].some((field) => fields.has(field));
}

export function supplierStockWasProvided(providedFields: readonly string[] | undefined): boolean {
  const fields = new Set(providedFields || []);
  return [...STOCK_PRESENCE_FIELDS].some((field) => fields.has(field));
}

export function hasExplicitSupplierCommerceMetadata(
  metadata: Record<string, unknown> | null | undefined,
  providedFields?: readonly string[],
): boolean {
  if (metadata) {
    if (typeof metadata.supplierCostAvailable === "boolean"
      && typeof metadata.supplierStockAvailable === "boolean") {
      return true;
    }
    if (Array.isArray(metadata.providedFields) && metadata.providedFields.length > 0) {
      return true;
    }
  }
  return Array.isArray(providedFields) && providedFields.length > 0;
}

export function readSupplierCommerceAvailability(input: {
  supplierMetadata?: Record<string, unknown> | null;
  supplierSnapshot?: Record<string, unknown> | null;
  providedFields?: readonly string[];
}): SupplierCommerceAvailability {
  const metadata = (input.supplierMetadata && typeof input.supplierMetadata === "object"
    ? input.supplierMetadata
    : input.supplierSnapshot?.supplierMetadata && typeof input.supplierSnapshot.supplierMetadata === "object"
      ? input.supplierSnapshot.supplierMetadata as Record<string, unknown>
      : input.supplierSnapshot) as Record<string, unknown> | undefined;

  if (metadata && typeof metadata.supplierCostAvailable === "boolean"
    && typeof metadata.supplierStockAvailable === "boolean") {
    return {
      supplierCostAvailable: metadata.supplierCostAvailable,
      supplierStockAvailable: metadata.supplierStockAvailable,
    };
  }

  const providedFields = [
    ...(Array.isArray(metadata?.providedFields) ? metadata.providedFields as string[] : []),
    ...(Array.isArray(input.providedFields) ? input.providedFields : []),
    ...(Array.isArray(input.supplierSnapshot?.providedFields) ? input.supplierSnapshot.providedFields as string[] : []),
  ];

  return {
    supplierCostAvailable: supplierCostWasProvided(providedFields),
    supplierStockAvailable: supplierStockWasProvided(providedFields),
  };
}

export function formatSupplierCostLabel(
  cost: number | null | undefined,
  available: boolean,
): string {
  if (!available) return "Not supplied";
  if (!Number.isFinite(cost)) return "Not supplied";
  return `LKR ${Math.round(cost).toLocaleString()}`;
}

export function formatSupplierStockLabel(
  stock: number | null | undefined,
  available: boolean,
): string {
  if (!available) return "Not supplied";
  if (!Number.isFinite(stock)) return "Not supplied";
  if (stock <= 0) return "0 / Out of stock";
  return String(Math.floor(stock));
}

export function formatSupplierProfitLabel(
  profit: number | null | undefined,
  available: boolean,
): string {
  if (!available || !Number.isFinite(profit)) return "Unavailable";
  return `LKR ${Math.round(profit).toLocaleString()}`;
}

export function formatSupplierMarginLabel(
  marginPercent: number | null | undefined,
  available: boolean,
): string {
  if (!available || !Number.isFinite(marginPercent)) return "Unavailable";
  return `${marginPercent.toFixed(2)}%`;
}
