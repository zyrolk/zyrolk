import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertCustomerCanCancelOrder } from '../functions/src/api/orders/orderStatusLogic';
import {
  buildCustomerOrderTimeline,
  calculateCustomerOrderTotals,
  filterCustomerOrders,
  getCustomerOrderReference,
  getPaymentMethodLabel,
  normalizeCustomerOrder,
  resolveBuyAgainItems,
} from '../src/features/account/customerOrders';
import { Product } from '../src/types';

const app = readFileSync('src/App.tsx', 'utf8');
const account = readFileSync('src/features/account/AccountCenter.tsx', 'utf8');
const ordersView = readFileSync('src/features/account/CustomerOrdersView.tsx', 'utf8');
const styles = readFileSync('src/features/account/accountCenter.css', 'utf8');
const functionRoute = readFileSync('functions/src/api/routes/orders.ts', 'utf8');
const localServer = readFileSync('server.ts', 'utf8');
const rules = readFileSync('firestore.rules', 'utf8');

const sourceOrder = {
  orderNumber: 'ZY10042',
  customerUid: 'customer-1',
  customerName: 'Asha Perera',
  customerPhone: '+94 77 123 4567',
  customerPhone2: '',
  customerEmail: 'asha@example.com',
  customerAddress: '12 Main Road',
  city: 'Colombo',
  district: 'Colombo',
  items: [
    { productId: 'product-1', name: 'Live Product', price: 1500, quantity: 2, imageUrl: 'https://example.com/product.jpg' },
    { productId: 'product-2', name: 'Second Item', price: 500, quantity: 1, imageUrl: '' },
  ],
  totalPrice: 3850,
  status: 'processing',
  stockDeducted: true,
  paymentMethod: 'cod',
  createdAt: '2026-07-18T08:00:00.000Z',
};

const product = (id: string, stock = 5, active = true): Product => ({
  id, name: id, description: '', price: 1000, imageUrl: '', category: 'test', rating: 0,
  reviewsCount: 0, isActive: active, stock, specs: {},
});

test('live Firestore order documents normalize into the customer-safe details contract', () => {
  const order = normalizeCustomerOrder('firestore-id', { ...sourceOrder, notes: '  Call before delivery.  ' });
  assert.equal(order.id, 'firestore-id');
  assert.equal(order.orderNumber, 'ZY10042');
  assert.equal(order.status, 'processing');
  assert.equal(order.items.length, 2);
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.orderNotes, 'Call before delivery.');
  assert.equal(getCustomerOrderReference(order), 'ZY10042');
  assert.equal(getPaymentMethodLabel(order.paymentMethod), 'Cash on Delivery');
});

test('unknown or malformed order fields fail safely without inventing commerce values', () => {
  const order = normalizeCustomerOrder('abcdefghijk', {
    status: 'unknown', totalPrice: Number.NaN, items: [{ name: '', quantity: -2, price: -5 }],
  });
  assert.equal(order.status, 'pending');
  assert.equal(order.totalPrice, 0);
  assert.equal(order.items[0].name, 'Product');
  assert.equal(order.items[0].price, 0);
  assert.equal(order.items[0].quantity, 1);
  assert.equal(getCustomerOrderReference(order), 'ABCDEFGH');
});

test('search and filters cover order IDs, order numbers, customer details, and product names', () => {
  const processing = normalizeCustomerOrder('firestore-id', sourceOrder);
  const delivered = normalizeCustomerOrder('delivered-id', { ...sourceOrder, orderNumber: 'ZY10043', status: 'delivered', items: [{ ...sourceOrder.items[0], name: 'Rice Cooker' }] });
  const orders = [processing, delivered];
  assert.deepEqual(filterCustomerOrders(orders, '10042', 'all').map(order => order.id), ['firestore-id']);
  assert.deepEqual(filterCustomerOrders(orders, 'rice cooker', 'all').map(order => order.id), ['delivered-id']);
  assert.deepEqual(filterCustomerOrders(orders, '', 'delivered').map(order => order.id), ['delivered-id']);
  assert.equal(filterCustomerOrders(orders, 'missing', 'all').length, 0);
});

test('timeline supports every required active state and a terminal cancelled branch', () => {
  const shipped = buildCustomerOrderTimeline('shipped');
  assert.deepEqual(shipped.map(step => step.id), ['pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered']);
  assert.equal(shipped.find(step => step.id === 'packed')?.state, 'complete');
  assert.equal(shipped.find(step => step.id === 'shipped')?.state, 'current');
  assert.equal(shipped.find(step => step.id === 'delivered')?.state, 'upcoming');
  assert.deepEqual(buildCustomerOrderTimeline('cancelled'), [
    { id: 'pending', label: 'Pending', state: 'complete' },
    { id: 'cancelled', label: 'Cancelled', state: 'current' },
  ]);
});

test('invoice totals derive delivery honestly from the existing total contract', () => {
  assert.deepEqual(calculateCustomerOrderTotals(normalizeCustomerOrder('order', sourceOrder)), {
    itemsSubtotal: 3500,
    deliveryFee: 350,
    grandTotal: 3850,
  });
  assert.deepEqual(calculateCustomerOrderTotals(normalizeCustomerOrder('order', { ...sourceOrder, totalPrice: 3500 })), {
    itemsSubtotal: 3500,
    deliveryFee: 0,
    grandTotal: 3500,
  });
});

test('Buy Again resolves only current active in-stock Firestore products and clamps quantity', () => {
  const order = normalizeCustomerOrder('order', sourceOrder);
  const resolved = resolveBuyAgainItems(order, [product('product-1', 1), product('product-2', 10, false)]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].product.id, 'product-1');
  assert.equal(resolved[0].quantity, 1);
});

test('customer cancellation authorization hides foreign orders and permits pending owners only', () => {
  assert.doesNotThrow(() => assertCustomerCanCancelOrder('customer-1', 'customer-1', 'pending'));
  assert.throws(() => assertCustomerCanCancelOrder('customer-2', 'customer-1', 'pending'), error => (
    error instanceof Error && error.message === 'Order not found' && (error as Error & { statusCode?: number }).statusCode === 404
  ));
  assert.throws(() => assertCustomerCanCancelOrder('customer-1', 'customer-1', 'confirmed'), error => (
    error instanceof Error && /Only pending orders/.test(error.message) && (error as Error & { statusCode?: number }).statusCode === 409
  ));
});

test('trusted cancellation endpoints require Firebase auth, ownership, pending status, and stock restoration logic', () => {
  for (const source of [functionRoute, localServer]) {
    assert.match(source, /\/api\/orders\/:orderId\/cancel/);
    assert.match(source, /verifyIdToken/);
    assert.match(source, /assertCustomerCanCancelOrder/);
    assert.match(source, /buildOrderStatusPlan/);
    assert.match(source, /stockRestorationApplied/);
    assert.match(source, /statusUpdatedAt/);
  }
  assert.match(functionRoute, /updateOrderStatus\(orderId, "cancelled", res\.locals\.customerUid\)/);
  assert.match(functionRoute, /requireAdminAuth/);
});

test('customer clients cannot bypass the trusted cancellation endpoint through Firestore', () => {
  assert.match(rules, /match \/orders\/\{orderId\}[\s\S]*allow create, update, delete: if false/);
  assert.match(ordersView, /user\.getIdToken\(\)/);
  assert.match(ordersView, /Authorization: `Bearer \$\{token\}`/);
  assert.match(ordersView, /order\.status !== 'pending'/);
  assert.doesNotMatch(ordersView, /updateDoc|setDoc|deleteDoc/);
});

test('My Orders preserves state-based routing and consumes the existing owner-scoped listener', () => {
  assert.match(app, /'account-orders', 'account-order-details'/);
  assert.match(account, /where\('customerUid', '==', user\.uid\)/);
  assert.match(account, /normalizeCustomerOrder\(orderDoc\.id, orderDoc\.data\(\)\)/);
  assert.match(account, /<CustomerOrdersView/);
  assert.match(account, /onAddToCart=\{onAddToCart\}/);
  assert.match(account, /onOpenCart=\{onOpenCart\}/);
});

test('order history provides search, status filters, responsive cards, loading and empty states', () => {
  assert.match(ordersView, /placeholder="Search order ID or product"/);
  assert.match(ordersView, /CUSTOMER_ORDER_STATUSES/);
  assert.match(ordersView, /zy-order-card-list/);
  assert.match(ordersView, /Loading your orders/);
  assert.match(ordersView, /No orders yet/);
  assert.match(ordersView, /No matching orders/);
  assert.match(styles, /\.zy-order-card-list\s*\{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.zy-order-card-list/);
});

test('order details include required customer, shipping, payment, item, total, note, and timeline surfaces', () => {
  assert.match(ordersView, /Account information/);
  assert.match(ordersView, /Shipping address/);
  assert.match(ordersView, /Payment method/);
  assert.match(ordersView, /No notes were added to this order/);
  assert.match(ordersView, /Order items/);
  assert.match(ordersView, /Items subtotal/);
  assert.match(ordersView, /Order total/);
  assert.match(ordersView, /Order timeline/);
  assert.match(ordersView, /aria-current=\{step\.state === 'current' \? 'step'/);
});

test('customer actions cover cancellation, reorder, support, WhatsApp, copy, and PDF-ready printing', () => {
  assert.match(ordersView, /Cancel Order/);
  assert.match(ordersView, /Confirm cancellation/);
  assert.match(ordersView, /Buy Again/);
  assert.match(ordersView, /Contact Support/);
  assert.match(ordersView, /WhatsApp Support/);
  assert.match(ordersView, /navigator\.clipboard\.writeText/);
  assert.match(ordersView, /window\.print\(\)/);
  assert.match(ordersView, /PDF-ready invoice foundation/);
  assert.match(styles, /@media print/);
  assert.match(styles, /#customer-order-invoice/);
});

test('Sprint 80 UI includes keyboard focus, friendly errors, reduced motion, and print exclusions', () => {
  assert.match(ordersView, /detailsHeadingRef\.current\?\.focus/);
  assert.match(ordersView, /role=\{actionError \? 'alert' : 'status'\}/);
  assert.match(ordersView, /fallbackMessage: 'This order could not be cancelled/);
  assert.match(ordersView, /aria-label="Filter orders by status"/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.zy-no-print/);
  assert.match(styles, /\.zy-order-timeline li\.is-current/);
});
