export interface OrderStockItem { productId?: unknown; quantity?: unknown }

export const ORDER_STATUSES = [
  'pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled',
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

const SUPPLIER_FULFILMENT_NOT_STARTED = new Set(['', 'pending']);
const SUPPLIER_FULFILMENT_ORDER_STATUSES = new Set<OrderStatus>([
  'confirmed', 'processing', 'packed', 'shipped',
]);

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

export function hasSupplierFulfilmentStarted(value: unknown): boolean {
  const status = value === undefined || value === null ? '' : String(value).trim().toLowerCase();
  return !SUPPLIER_FULFILMENT_NOT_STARTED.has(status);
}

export function hasSupplierAssignment(order: Record<string, unknown>): boolean {
  if (order.supplierAssignmentActive === true) return true;
  const supplierId = typeof order.supplierId === 'string' ? order.supplierId.trim() : '';
  const supplierIds = Array.isArray(order.supplierIds)
    ? order.supplierIds.some((value) => typeof value === 'string' && value.trim())
    : false;
  return Boolean(supplierId || supplierIds);
}

export function assertOrderCanBeAssignedToSupplier(order: Record<string, unknown>): void {
  const status = normalizeOrderStatus(order.status);
  if (!status || !SUPPLIER_FULFILMENT_ORDER_STATUSES.has(status)) {
    throw Object.assign(new Error('Supplier assignment requires a confirmed active order'), { statusCode: 409 });
  }
  if (String(order.stockReservationStatus || '').trim().toLowerCase() !== 'committed'
    || order.stockRestorationApplied === true) {
    throw Object.assign(new Error('Supplier assignment requires committed inventory'), { statusCode: 409 });
  }
  if (hasSupplierFulfilmentStarted(order.supplierFulfilmentStatus)) {
    throw Object.assign(new Error('Supplier assignment cannot change after fulfilment has started'), { statusCode: 409 });
  }
}

export function assertOrderCanProgressSupplierFulfilment(
  orderStatus: unknown,
  stockReservationStatus: unknown,
  stockRestorationApplied: unknown,
): void {
  const status = normalizeOrderStatus(orderStatus);
  if (!status || !SUPPLIER_FULFILMENT_ORDER_STATUSES.has(status)) {
    throw Object.assign(new Error('Supplier fulfilment requires a confirmed active order'), { statusCode: 409 });
  }
  if (String(stockReservationStatus || '').trim().toLowerCase() !== 'committed'
    || stockRestorationApplied === true) {
    throw Object.assign(new Error('Supplier fulfilment requires committed inventory'), { statusCode: 409 });
  }
}

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
  supplierFulfilmentStatus?: unknown,
): { shouldRestoreStock: boolean; quantities: Map<string, number> } {
  const next = assertValidOrderStatusTransition(currentStatus, newStatus);
  if (next === 'cancelled'
    && normalizeOrderStatus(currentStatus) !== 'cancelled'
    && hasSupplierFulfilmentStarted(supplierFulfilmentStatus)) {
    throw Object.assign(new Error('Order cannot be cancelled after supplier fulfilment has started'), { statusCode: 409 });
  }
  const shouldRestoreStock = newStatus === 'cancelled' && stockDeducted === true && stockRestorationApplied !== true;
  const quantities = shouldRestoreStock ? collectOrderStockQuantities(items) : new Map<string, number>();
  return { shouldRestoreStock, quantities };
}
