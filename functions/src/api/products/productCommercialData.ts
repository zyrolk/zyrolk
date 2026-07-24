export const PRODUCT_PRIVATE_COLLECTION = "product_private";

export const COMMERCIAL_PRODUCT_FIELDS = [
  "supplierItemCode",
  "supplierItemCodeNormalized",
  "supplierId",
  "costPrice",
  "marketPrice",
  "supplierPurchasePrice",
  "supplierInternalNotes",
  "supplierProfit",
  "supplierPrice",
  "purchasePrice",
  "profitMargin",
  "commission",
  "supplierMetadata",
  "supplierMedia",
  "supplierCommercialMetadata",
  "wholesalePrice",
  "recommendedRetailPrice",
  "supplierCode",
  "supplierSku",
  "supplierSKU",
  "supplierCost",
  "internalCost",
  "margin",
  "profit",
  "supplierSourceId",
  "supplierSource",
  "supplierLeadTime",
  "supplierMoq",
  "supplierMOQ",
] as const;

const fieldSet = new Set<string>(COMMERCIAL_PRODUCT_FIELDS);

export function splitProductData(value: Readonly<Record<string, unknown>>): {
  publicData: Record<string, unknown>;
  commercialData: Record<string, unknown>;
} {
  const publicData: Record<string, unknown> = {};
  const commercialData: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldSet.has(key)) {
      if (fieldValue !== undefined && fieldValue !== "") commercialData[key] = fieldValue;
    } else {
      publicData[key] = fieldValue;
    }
  }
  const supplierCode = typeof commercialData.supplierItemCode === "string"
    ? commercialData.supplierItemCode.trim()
    : "";
  if (supplierCode) commercialData.supplierItemCodeNormalized = supplierCode.toLocaleLowerCase();
  return { publicData, commercialData };
}

export function mergeProductData(
  publicData: Readonly<Record<string, unknown>>,
  commercialData: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return { ...publicData, ...(commercialData || {}) };
}

export function sanitizePublicProductData(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return splitProductData(value).publicData;
}
