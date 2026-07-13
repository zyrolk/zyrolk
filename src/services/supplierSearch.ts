export interface SupplierSearchRecord {
  productName?: unknown;
  title?: unknown;
  supplierName?: unknown;
  supplierCode?: unknown;
  supplierItemCode?: unknown;
  sku?: unknown;
  productPayload?: {
    supplierItemCode?: unknown;
    sku?: unknown;
  } | null;
}

export const normalizeSupplierSearchValue = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '');

export function matchesSupplierSearch(record: SupplierSearchRecord, query: string): boolean {
  const normalizedQuery = normalizeSupplierSearchValue(query);
  if (!normalizedQuery) return true;

  return [
    record.productName,
    record.title,
    record.supplierName,
    record.supplierCode,
    record.supplierItemCode,
    record.sku,
    record.productPayload?.supplierItemCode,
    record.productPayload?.sku,
  ].some((value) => normalizeSupplierSearchValue(value).includes(normalizedQuery));
}
