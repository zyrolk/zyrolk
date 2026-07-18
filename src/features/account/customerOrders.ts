import { Product } from '../../types';

export const CUSTOMER_ORDER_STATUSES = [
  'pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled',
] as const;

export type CustomerOrderStatus = typeof CUSTOMER_ORDER_STATUSES[number];
export type CustomerOrderFilter = 'all' | CustomerOrderStatus;

export interface CustomerOrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  imageUrl: string;
}

export interface CustomerOrder {
  id: string;
  orderNumber?: string;
  customerUid: string;
  customerName: string;
  customerPhone: string;
  customerPhone2?: string;
  customerEmail: string;
  customerAddress: string;
  district: string;
  city?: string;
  items: CustomerOrderItem[];
  totalPrice: number;
  status: CustomerOrderStatus;
  paymentMethod: string;
  createdAt?: string;
  orderNotes?: string;
}

export interface CustomerOrderTimelineStep {
  id: CustomerOrderStatus;
  label: string;
  state: 'complete' | 'current' | 'upcoming';
}

const ACTIVE_TIMELINE: Array<{ id: Exclude<CustomerOrderStatus, 'cancelled'>; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'processing', label: 'Processing' },
  { id: 'packed', label: 'Packed' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'delivered', label: 'Delivered' },
];

const cleanText = (value: unknown, maxLength = 500): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, maxLength) : ''
);

const safeNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const normalizeStatus = (value: unknown): CustomerOrderStatus => {
  const status = cleanText(value, 30).toLowerCase();
  return CUSTOMER_ORDER_STATUSES.includes(status as CustomerOrderStatus)
    ? status as CustomerOrderStatus
    : 'pending';
};

export function normalizeCustomerOrder(id: string, value: Record<string, unknown>): CustomerOrder {
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.map((rawItem): CustomerOrderItem | null => {
    if (!rawItem || typeof rawItem !== 'object') return null;
    const item = rawItem as Record<string, unknown>;
    const productId = cleanText(item.productId, 200);
    const name = cleanText(item.name, 240) || 'Product';
    const quantity = Math.max(1, Math.floor(safeNumber(item.quantity)) || 1);
    return {
      productId,
      name,
      price: safeNumber(item.price),
      quantity,
      imageUrl: cleanText(item.imageUrl, 2000),
    };
  }).filter((item): item is CustomerOrderItem => Boolean(item));

  return {
    id: cleanText(id, 200),
    orderNumber: cleanText(value.orderNumber, 80) || undefined,
    customerUid: cleanText(value.customerUid, 200),
    customerName: cleanText(value.customerName, 120),
    customerPhone: cleanText(value.customerPhone, 30),
    customerPhone2: cleanText(value.customerPhone2, 30) || undefined,
    customerEmail: cleanText(value.customerEmail, 160),
    customerAddress: cleanText(value.customerAddress, 500),
    district: cleanText(value.district, 80),
    city: cleanText(value.city, 80) || undefined,
    items,
    totalPrice: safeNumber(value.totalPrice),
    status: normalizeStatus(value.status),
    paymentMethod: cleanText(value.paymentMethod, 80) || 'cod',
    createdAt: cleanText(value.createdAt, 80) || undefined,
    orderNotes: cleanText(value.orderNotes ?? value.notes, 2000) || undefined,
  };
}

export function filterCustomerOrders(
  orders: readonly CustomerOrder[],
  query: string,
  status: CustomerOrderFilter,
): CustomerOrder[] {
  const normalizedQuery = cleanText(query, 200).toLocaleLowerCase('en');
  return orders.filter(order => {
    if (status !== 'all' && order.status !== status) return false;
    if (!normalizedQuery) return true;
    const searchable = [
      order.id, order.orderNumber, order.customerName, order.customerEmail,
      ...order.items.map(item => item.name),
    ].filter(Boolean).join(' ').toLocaleLowerCase('en');
    return searchable.includes(normalizedQuery);
  });
}

export function buildCustomerOrderTimeline(status: CustomerOrderStatus): CustomerOrderTimelineStep[] {
  if (status === 'cancelled') {
    return [
      { id: 'pending', label: 'Pending', state: 'complete' },
      { id: 'cancelled', label: 'Cancelled', state: 'current' },
    ];
  }
  const currentIndex = Math.max(0, ACTIVE_TIMELINE.findIndex(step => step.id === status));
  return ACTIVE_TIMELINE.map((step, index) => ({
    ...step,
    state: index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming',
  }));
}

export function calculateCustomerOrderTotals(order: Pick<CustomerOrder, 'items' | 'totalPrice'>): {
  itemsSubtotal: number;
  deliveryFee: number;
  grandTotal: number;
} {
  const itemsSubtotal = order.items.reduce((total, item) => total + (item.price * item.quantity), 0);
  const grandTotal = safeNumber(order.totalPrice);
  return {
    itemsSubtotal,
    deliveryFee: Math.max(0, grandTotal - itemsSubtotal),
    grandTotal,
  };
}

export function resolveBuyAgainItems(
  order: Pick<CustomerOrder, 'items'>,
  products: readonly Product[],
): Array<{ product: Product; quantity: number }> {
  const productById = new Map(products.map(product => [product.id, product]));
  return order.items.flatMap(item => {
    const product = productById.get(item.productId);
    if (!product || product.isActive === false || product.stock <= 0) return [];
    return [{ product, quantity: Math.min(product.stock, Math.max(1, item.quantity)) }];
  });
}

export function getCustomerOrderReference(order: Pick<CustomerOrder, 'id' | 'orderNumber'>): string {
  return order.orderNumber || order.id.slice(0, 8).toUpperCase();
}

export function getPaymentMethodLabel(paymentMethod: string): string {
  if (paymentMethod === 'cod') return 'Cash on Delivery';
  if (paymentMethod === 'whatsapp_confirm') return 'WhatsApp confirmation';
  return cleanText(paymentMethod, 80).replace(/[_-]+/gu, ' ') || 'Not available';
}
