import type { SupplierPortalOrder } from './types';

export const supplierOrderDisplayStatus = (
  order: Pick<SupplierPortalOrder, 'status' | 'attributionAvailable' | 'supplierFulfilmentStatus'>,
): string => {
  if (order.status === 'cancelled') return 'cancelled';
  return order.attributionAvailable ? order.supplierFulfilmentStatus : 'legacy attribution unavailable';
};
