export interface OrderStockItem { productId?: unknown; quantity?: unknown }

export const ORDER_STATUSES = [
  'pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled',
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['packed', 'shipped', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const normalizeOrderStatus = (value: unknown): OrderStatus | null => {
  const status = String(value || 'pending').trim().toLowerCase();
  return (ORDER_STATUSES as readonly string[]).includes(status) ? status as OrderStatus : null;
};

export function allowedOrderStatusTransitions(currentStatus: unknown): readonly OrderStatus[] {
  const current = normalizeOrderStatus(currentStatus);
  return current ? ORDER_STATUS_TRANSITIONS[current] : [];
}

export function assertValidOrderStatusTransition(currentStatus: unknown, newStatus: unknown): OrderStatus {
  const current = normalizeOrderStatus(currentStatus);
  const next = normalizeOrderStatus(newStatus);
  if (!current || !next) {
    throw Object.assign(new Error('Order status is invalid'), { statusCode: 409 });
  }
  if (current === next) return next;
  if (!ORDER_STATUS_TRANSITIONS[current].includes(next)) {
    throw Object.assign(new Error(`Order status cannot be moved from ${current} to ${next}`), { statusCode: 409 });
  }
  return next;
}

export function collectOrderStockQuantities(items: unknown): Map<string, number> {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('Order inventory data is invalid'), { statusCode: 409 });
  }
  const quantities = new Map<string, number>();
  for (const item of items as OrderStockItem[]) {
    const productId = typeof item.productId === 'string' ? item.productId.trim() : '';
    const quantity = Number(item.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw Object.assign(new Error('Order inventory data is invalid'), { statusCode: 409 });
    }
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return quantities;
}

export function requireCurrentProductStock(productExists: boolean, stockValue: unknown): number {
  const stock = Number(stockValue);
  if (!productExists || !Number.isInteger(stock) || stock < 0) {
    throw Object.assign(new Error('Order inventory could not be reconciled'), { statusCode: 409 });
  }
  return stock;
}

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
  assertValidOrderStatusTransition(currentStatus, newStatus);
  const shouldRestoreStock = newStatus === 'cancelled' && stockDeducted === true && stockRestorationApplied !== true;
  const quantities = shouldRestoreStock ? collectOrderStockQuantities(items) : new Map<string, number>();
  return { shouldRestoreStock, quantities };
}
