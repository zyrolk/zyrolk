import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronRight, CircleDot, Clock3, Copy,
  FileText, Headphones, LoaderCircle, MapPin, MessageCircle, Package, PackageCheck, Printer,
  RefreshCw, RotateCcw, Search, ShieldCheck, ShoppingBag, Truck, UserRound, X, XCircle,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { Product, WebsiteSettings } from '../../types';
import { fetchJson } from '../../services/network/fetchJson';
import { reportClientIssue } from '../../services/observability/clientDiagnostics';
import { formatAccountDate } from './accountData';
import {
  CUSTOMER_ORDER_STATUSES, CustomerOrder, CustomerOrderFilter, CustomerOrderStatus,
  buildCustomerOrderTimeline, calculateCustomerOrderTotals, filterCustomerOrders,
  getCustomerOrderReference, getPaymentMethodLabel, resolveBuyAgainItems,
} from './customerOrders';

interface CustomerOrdersProps {
  mode: 'list' | 'details';
  user: User;
  orders: CustomerOrder[];
  loading: boolean;
  selectedOrderId: string | null;
  products: Product[];
  settings: WebsiteSettings | null;
  onSelectOrder: (orderId: string) => void;
  onBackToOrders: () => void;
  onAddToCart: (product: Product, quantity: number) => void;
  onOpenCart: () => void;
  onContactSupport: () => void;
}

const STATUS_LABELS: Record<CustomerOrderStatus, string> = {
  pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', packed: 'Packed',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled',
};

const STATUS_ICONS: Record<CustomerOrderStatus, typeof Clock3> = {
  pending: Clock3, confirmed: CheckCircle2, processing: RefreshCw, packed: Package,
  shipped: Truck, delivered: PackageCheck, cancelled: XCircle,
};

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(Number.isFinite(amount) ? amount : 0);

const OrderSkeleton = () => (
  <div className="zy-order-skeleton" role="status" aria-label="Loading your orders">
    <span className="sr-only">Loading your orders</span>
    {Array.from({ length: 4 }, (_, index) => <i key={index} aria-hidden="true" />)}
  </div>
);

const StatusBadge = ({ status }: { status: CustomerOrderStatus }) => {
  const Icon = STATUS_ICONS[status];
  return <span className={`zy-order-status is-${status}`}><Icon aria-hidden="true" />{STATUS_LABELS[status]}</span>;
};

export default function CustomerOrdersView({
  mode, user, orders, loading, selectedOrderId, products, settings, onSelectOrder, onBackToOrders,
  onAddToCart, onOpenCart, onContactSupport,
}: CustomerOrdersProps) {
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CustomerOrderFilter>('all');
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelSaving, setCancelSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [copied, setCopied] = useState(false);

  const selectedOrder = selectedOrderId ? orders.find(order => order.id === selectedOrderId) || null : null;
  const filteredOrders = useMemo(
    () => filterCustomerOrders(orders, searchQuery, statusFilter),
    [orders, searchQuery, statusFilter],
  );

  useEffect(() => {
    setCancelConfirming(false);
    setActionMessage('');
    setActionError('');
    if (mode === 'details') {
      const frame = window.requestAnimationFrame(() => detailsHeadingRef.current?.focus({ preventScroll: true }));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [mode, selectedOrderId]);

  const copyOrderId = async (order: CustomerOrder) => {
    setActionError('');
    try {
      await navigator.clipboard.writeText(order.orderNumber || order.id);
      setCopied(true);
      setActionMessage('Order ID copied to your clipboard.');
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      reportClientIssue('customer-order-copy', error, 'warning');
      setActionError('The order ID could not be copied automatically.');
    }
  };

  const buyAgain = (order: CustomerOrder) => {
    const availableItems = resolveBuyAgainItems(order, products);
    if (availableItems.length === 0) {
      setActionError('None of this order’s products are currently available to add again.');
      setActionMessage('');
      return;
    }
    availableItems.forEach(({ product, quantity }) => onAddToCart(product, quantity));
    setActionError('');
    setActionMessage(`${availableItems.length} available ${availableItems.length === 1 ? 'product was' : 'products were'} added to your cart.`);
    onOpenCart();
  };

  const openWhatsAppSupport = (order: CustomerOrder) => {
    const whatsappNumber = settings?.whatsappNumber?.replace(/\D/gu, '') || '';
    if (!whatsappNumber) {
      setActionError('WhatsApp support is not configured right now. Please use Contact Support instead.');
      return;
    }
    const reference = getCustomerOrderReference(order);
    const message = encodeURIComponent(`Hello Zyro.lk, I need help with order ${reference}.`);
    window.open(`https://wa.me/${whatsappNumber}?text=${message}`, '_blank', 'noopener,noreferrer');
  };

  const cancelPendingOrder = async (order: CustomerOrder) => {
    if (!cancelConfirming) {
      setCancelConfirming(true);
      setActionMessage('Confirm cancellation only if you no longer need this pending order.');
      setActionError('');
      return;
    }
    if (order.status !== 'pending' || cancelSaving) return;
    setCancelSaving(true);
    setActionError('');
    try {
      const token = await user.getIdToken();
      await fetchJson<{ success: true; status: 'cancelled'; stockRestored: boolean }>(
        `/api/orders/${encodeURIComponent(order.id)}/cancel`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
        { fallbackMessage: 'This order could not be cancelled. Please contact support.' },
      );
      setCancelConfirming(false);
      setActionMessage('Order cancelled successfully. Your live order status will refresh shortly.');
    } catch (error) {
      reportClientIssue('customer-order-cancel', error, 'warning');
      setActionError(error instanceof Error ? error.message : 'This order could not be cancelled. Please contact support.');
    } finally {
      setCancelSaving(false);
    }
  };

  if (mode === 'list') {
    return (
      <div className="zy-customer-orders">
        <div className="zy-order-history-toolbar">
          <label>
            <span className="sr-only">Search your orders</span>
            <Search aria-hidden="true" />
            <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search order ID or product" type="search" />
          </label>
          <span>{filteredOrders.length} of {orders.length} orders</span>
        </div>

        <div className="zy-order-filter-row" role="group" aria-label="Filter orders by status">
          {(['all', ...CUSTOMER_ORDER_STATUSES] as CustomerOrderFilter[]).map(status => {
            const count = status === 'all' ? orders.length : orders.filter(order => order.status === status).length;
            return (
              <button key={status} type="button" onClick={() => setStatusFilter(status)} className={statusFilter === status ? 'is-active' : ''} aria-pressed={statusFilter === status}>
                {status === 'all' ? 'All orders' : STATUS_LABELS[status]} <span>{count}</span>
              </button>
            );
          })}
        </div>

        {loading ? <OrderSkeleton /> : orders.length === 0 ? (
          <div className="zy-account-empty zy-order-empty"><ShoppingBag /><strong>No orders yet</strong><p>Your authenticated Zyro.lk orders will appear here after checkout.</p></div>
        ) : filteredOrders.length === 0 ? (
          <div className="zy-account-empty zy-order-empty"><Search /><strong>No matching orders</strong><p>Try a different order ID, product name, or status filter.</p><button type="button" onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}>Clear filters</button></div>
        ) : (
          <div className="zy-order-card-list">
            {filteredOrders.map(order => {
              const previewItems = order.items.slice(0, 3);
              return (
                <article key={order.id} className="zy-order-card">
                  <header>
                    <div><small>Order</small><h2>#{getCustomerOrderReference(order)}</h2><span>{formatAccountDate(order.createdAt)}</span></div>
                    <StatusBadge status={order.status} />
                  </header>
                  <div className="zy-order-card-products" aria-label={`${order.items.length} order items`}>
                    <div className="zy-order-card-images">
                      {previewItems.map((item, index) => <span key={`${item.productId}-${index}`}><img src={item.imageUrl || '/logo.png'} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /></span>)}
                    </div>
                    <div><strong>{order.items[0]?.name || 'Order items unavailable'}</strong><span>{order.items.length} {order.items.length === 1 ? 'item' : 'items'} · {order.items.reduce((total, item) => total + item.quantity, 0)} units</span></div>
                  </div>
                  <footer><div><small>Order total</small><strong>{formatPrice(order.totalPrice)}</strong></div><button type="button" onClick={() => onSelectOrder(order.id)}>View order <ChevronRight aria-hidden="true" /></button></footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (loading) return <OrderSkeleton />;

  if (!selectedOrder) {
    return (
      <div className="zy-account-empty zy-order-empty">
        <FileText /><strong>Select an order to view its details</strong>
        <p>Open My Orders and choose an order from your live history.</p>
        <button type="button" onClick={onBackToOrders}><ArrowLeft /> Back to My Orders</button>
      </div>
    );
  }

  const timeline = buildCustomerOrderTimeline(selectedOrder.status);
  const totals = calculateCustomerOrderTotals(selectedOrder);
  const reference = getCustomerOrderReference(selectedOrder);

  return (
    <div className="zy-order-details" id="customer-order-invoice">
      <div className="zy-order-details-topbar zy-no-print">
        <button type="button" onClick={onBackToOrders}><ArrowLeft /> My Orders</button>
        <div><button type="button" onClick={() => copyOrderId(selectedOrder)}>{copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy Order ID'}</button><button type="button" onClick={() => window.print()}><Printer /> Print invoice</button></div>
      </div>

      {(actionError || actionMessage) && <div className={`zy-account-alert ${actionError ? 'is-error' : 'is-success'} zy-no-print`} role={actionError ? 'alert' : 'status'}>{actionError || actionMessage}</div>}

      <section className="zy-order-invoice-head">
        <div><p className="zy-section-eyebrow">Zyro.lk order</p><h2 ref={detailsHeadingRef} tabIndex={-1}>Order #{reference}</h2><p>Placed {formatAccountDate(selectedOrder.createdAt)}</p></div>
        <div><StatusBadge status={selectedOrder.status} /><strong>{formatPrice(selectedOrder.totalPrice)}</strong><span>{selectedOrder.items.length} {selectedOrder.items.length === 1 ? 'item' : 'items'}</span></div>
      </section>

      <section className={`zy-order-timeline is-${selectedOrder.status}`} aria-labelledby="order-timeline-title">
        <div className="zy-account-panel-heading"><div><small>Live progress</small><h3 id="order-timeline-title">Order timeline</h3></div><Truck aria-hidden="true" /></div>
        <ol>
          {timeline.map(step => {
            const Icon = step.id === 'cancelled' ? X : step.state === 'complete' ? Check : step.state === 'current' ? CircleDot : Clock3;
            return <li key={step.id} className={`is-${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}><span><Icon aria-hidden="true" /></span><strong>{step.label}</strong><small>{step.state === 'complete' ? 'Complete' : step.state === 'current' ? 'Current status' : 'Upcoming'}</small></li>;
          })}
        </ol>
        {selectedOrder.status === 'cancelled' && <p className="zy-order-cancelled-note"><AlertTriangle aria-hidden="true" />This order was cancelled and will not continue through fulfilment.</p>}
      </section>

      <div className="zy-order-detail-grid">
        <section className="zy-account-form-card zy-order-contact-card"><div className="zy-account-panel-heading"><div><small>Customer</small><h3>Account information</h3></div><UserRound /></div><dl><div><dt>Name</dt><dd>{selectedOrder.customerName || 'Not available'}</dd></div><div><dt>Email</dt><dd>{selectedOrder.customerEmail || 'Not available'}</dd></div><div><dt>Phone</dt><dd>{selectedOrder.customerPhone || 'Not available'}</dd></div>{selectedOrder.customerPhone2 && <div><dt>Alternative phone</dt><dd>{selectedOrder.customerPhone2}</dd></div>}</dl></section>
        <section className="zy-account-form-card zy-order-contact-card"><div className="zy-account-panel-heading"><div><small>Delivery</small><h3>Shipping address</h3></div><MapPin /></div><address>{selectedOrder.customerAddress || 'Address not available'}{selectedOrder.city && <><br />{selectedOrder.city}</>}<br />{selectedOrder.district || 'District not available'}</address></section>
        <section className="zy-account-form-card zy-order-contact-card"><div className="zy-account-panel-heading"><div><small>Payment</small><h3>Payment method</h3></div><ShieldCheck /></div><strong className="zy-order-payment-method">{getPaymentMethodLabel(selectedOrder.paymentMethod)}</strong><p>Payment and checkout processing remain protected by the existing Zyro.lk commerce flow.</p></section>
        <section className="zy-account-form-card zy-order-contact-card"><div className="zy-account-panel-heading"><div><small>Order notes</small><h3>Notes</h3></div><FileText /></div>{selectedOrder.orderNotes ? <p className="zy-order-notes">{selectedOrder.orderNotes}</p> : <p className="zy-order-notes is-empty">No notes were added to this order.</p>}</section>
      </div>

      <section className="zy-account-form-card zy-order-items-section">
        <div className="zy-account-panel-heading"><div><small>Invoice items</small><h3>Order items</h3></div><Package /></div>
        <div className="zy-order-item-list">
          {selectedOrder.items.map((item, index) => <article key={`${item.productId}-${index}`}><span><img src={item.imageUrl || '/logo.png'} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /></span><div><strong>{item.name}</strong><small>Quantity {item.quantity}</small></div><div><small>{formatPrice(item.price)} each</small><strong>{formatPrice(item.price * item.quantity)}</strong></div></article>)}
        </div>
        <dl className="zy-order-totals"><div><dt>Items subtotal</dt><dd>{formatPrice(totals.itemsSubtotal)}</dd></div><div><dt>Delivery</dt><dd>{totals.deliveryFee === 0 ? 'Free' : formatPrice(totals.deliveryFee)}</dd></div><div><dt>Order total</dt><dd>{formatPrice(totals.grandTotal)}</dd></div></dl>
      </section>

      <section className="zy-order-actions zy-no-print" aria-labelledby="order-actions-title">
        <div><p className="zy-section-eyebrow">Need something?</p><h3 id="order-actions-title">Order actions</h3><p>Reorder available products or reach the Zyro.lk support team with this order reference.</p></div>
        <div className="zy-order-action-grid">
          <button type="button" onClick={() => buyAgain(selectedOrder)}><RotateCcw /><span><strong>Buy Again</strong><small>Add available items to cart</small></span></button>
          <button type="button" onClick={onContactSupport}><Headphones /><span><strong>Contact Support</strong><small>Open the support page</small></span></button>
          <button type="button" onClick={() => openWhatsAppSupport(selectedOrder)}><MessageCircle /><span><strong>WhatsApp Support</strong><small>Message with order reference</small></span></button>
          <button type="button" onClick={() => window.print()}><Printer /><span><strong>Print / Save PDF</strong><small>PDF-ready invoice foundation</small></span></button>
        </div>
        {selectedOrder.status === 'pending' && <div className={`zy-order-cancel-action ${cancelConfirming ? 'is-confirming' : ''}`}><div><AlertTriangle /><p><strong>{cancelConfirming ? 'Cancel this order?' : 'Need to cancel?'}</strong><span>{cancelConfirming ? 'This pending order will be cancelled and eligible deducted stock will be restored.' : 'Pending orders can be cancelled before confirmation.'}</span></p></div><div>{cancelConfirming && <button type="button" onClick={() => { setCancelConfirming(false); setActionMessage(''); }}>Keep order</button>}<button type="button" onClick={() => cancelPendingOrder(selectedOrder)} disabled={cancelSaving}>{cancelSaving ? <LoaderCircle className="animate-spin" /> : <XCircle />}{cancelSaving ? 'Cancelling' : cancelConfirming ? 'Confirm cancellation' : 'Cancel Order'}</button></div></div>}
      </section>

      <footer className="zy-order-print-footer"><strong>Zyro.lk</strong><span>Invoice foundation · Order #{reference}</span></footer>
    </div>
  );
}
