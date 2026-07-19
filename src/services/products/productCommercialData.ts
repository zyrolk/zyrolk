import type { Product } from '../../types';

export const PRODUCT_PRIVATE_COLLECTION = 'product_private';

export const COMMERCIAL_PRODUCT_FIELDS = [
  'supplierItemCode',
  'supplierItemCodeNormalized',
  'supplierId',
  'costPrice',
  'marketPrice',
  'supplierPurchasePrice',
  'supplierInternalNotes',
  'supplierProfit',
  'supplierPrice',
  'purchasePrice',
  'profitMargin',
  'commission',
  'supplierMetadata',
  'supplierCommercialMetadata',
  'wholesalePrice',
  'recommendedRetailPrice',
  'supplierCode',
  'supplierSku',
  'supplierSKU',
  'supplierCost',
  'internalCost',
  'margin',
  'profit',
  'supplierSourceId',
  'supplierSource',
  'supplierLeadTime',
  'supplierMoq',
  'supplierMOQ',
] as const;

export type CommercialProductField = typeof COMMERCIAL_PRODUCT_FIELDS[number];
export type ProductRecord = Partial<Product> & Record<string, unknown>;

const commercialFieldSet = new Set<string>(COMMERCIAL_PRODUCT_FIELDS);

export interface SplitProductData {
  readonly publicData: ProductRecord;
  readonly commercialData: Record<string, unknown>;
}

export function splitProductData(value: Readonly<Record<string, unknown>>): SplitProductData {
  const publicData: ProductRecord = {};
  const commercialData: Record<string, unknown> = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (commercialFieldSet.has(key)) {
      if (fieldValue !== undefined && fieldValue !== '') commercialData[key] = fieldValue;
    } else {
      publicData[key] = fieldValue;
    }
  }

  const supplierCode = typeof commercialData.supplierItemCode === 'string'
    ? commercialData.supplierItemCode.trim()
    : '';
  if (supplierCode) commercialData.supplierItemCodeNormalized = supplierCode.toLocaleLowerCase();

  return { publicData, commercialData };
}

export function mergeProductCommercialData(
  publicProduct: Readonly<ProductRecord>,
  commercialData: Readonly<Record<string, unknown>> | undefined,
): Product {
  return {
    ...publicProduct,
    ...(commercialData ?? {}),
  } as Product;
}

export function containsCommercialProductFields(value: Readonly<Record<string, unknown>>): boolean {
  return COMMERCIAL_PRODUCT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function buildCommercialFieldDeletes<T>(deleteValue: T): Record<CommercialProductField, T> {
  return Object.fromEntries(COMMERCIAL_PRODUCT_FIELDS.map((field) => [field, deleteValue])) as Record<CommercialProductField, T>;
}
