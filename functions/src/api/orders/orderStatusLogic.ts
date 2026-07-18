export interface OrderStockItem { productId?: unknown; quantity?: unknown }

export function assertCustomerCanCancelOrder(
  authenticatedUid: string,
  orderCustomerUid: unknown,
  currentStatus: unknown,
): void {
  if (!authenticatedUid || orderCustomerUid !== authenticatedUid) {
    throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  }
  if (String(currentStatus || 'pending').toLowerCase() !== 'pending') {
    throw Object.assign(new Error('Only pending orders can be cancelled'), { statusCode: 409 });
  }
}

export function buildOrderStatusPlan(
  currentStatus: unknown,
  newStatus: string,
  stockDeducted: unknown,
  stockRestorationApplied: unknown,
  items: unknown,
): { shouldRestoreStock: boolean; quantities: Map<string, number> } {
  const current = String(currentStatus || 'pending').toLowerCase();
  if (current === 'cancelled' && newStatus !== 'cancelled') {
    throw Object.assign(new Error('Cancelled orders cannot be moved to another status'), { statusCode: 409 });
  }
  const shouldRestoreStock = newStatus === 'cancelled' && stockDeducted === true && stockRestorationApplied !== true;
  const quantities = new Map<string, number>();
  if (shouldRestoreStock) {
    for (const item of Array.isArray(items) ? items as OrderStockItem[] : []) {
      const productId = typeof item.productId === 'string' ? item.productId.trim() : '';
      const quantity = Number(item.quantity);
      if (productId && Number.isInteger(quantity) && quantity > 0) {
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
      }
    }
  }
  return { shouldRestoreStock, quantities };
}
