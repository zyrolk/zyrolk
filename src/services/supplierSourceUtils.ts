export interface SupplierSourceLike {
  id: string;
  sourceStatus?: unknown;
  supplierType?: unknown;
  type?: unknown;
}

export const getSupplierSourceType = (source: SupplierSourceLike): string =>
  String(source.supplierType || source.type || 'website').trim().toLowerCase();

export const isActiveWebsiteSupplier = (source: SupplierSourceLike): boolean =>
  String(source.sourceStatus || 'active').trim().toLowerCase() === 'active' &&
  getSupplierSourceType(source) === 'website';
