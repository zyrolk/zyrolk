import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import {
  BadgePercent, Check, CheckCircle2, ChevronRight, CircleDollarSign, Copy, Home, LoaderCircle,
  LockKeyhole, MapPin, Minus, PackageCheck, Phone, Plus, ShieldCheck, ShoppingBag, Trash2, Truck, X,
} from 'lucide-react';
import type { CartDrawerProps } from '../../components/CartDrawer';
import { db } from '../../firebase';
import { fetchJson } from '../../services/network/fetchJson';
import { reportClientIssue } from '../../services/observability/clientDiagnostics';
import { CustomerAddress, SRI_LANKA_DISTRICTS, sortCustomerAddresses } from '../account/accountData';
import {
  CheckoutErrors, CheckoutField, CheckoutFormValues, EMPTY_CHECKOUT_FORM, checkoutFormFromAddress,
  clearCheckoutDraft, getCheckoutCartSignature, normalizeCheckoutForm, readCheckoutDraft,
  validateCheckoutForm, writeCheckoutDraft,
} from './checkoutModel';
import { Order } from '../../types';
import { trackCommerceEvent, trackPurchaseOnce } from '../../services/observability/commerceAnalytics';
import { PayHerePaymentSession, submitPayHerePayment } from './payhere';
import { resolveDeliveryCharge } from '../../services/settings/shippingSettings';
import './premiumCheckout.css';

const IDEMPOTENCY_KEY = 'zyro.checkout.idempotency';
const DISTRICT_DELIVERY: Record<string, number> = {
  Colombo: 350, Gampaha: 450, Kalutara: 450, Kandy: 550, Galle: 550, Matara: 550,
  Jaffna: 650, Kurunegala: 500, Anuradhapura: 600, Badulla: 600, Ratnapura: 500,
  Batticaloa: 650, Trincomalee: 650,
};

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(amount);

function createIdempotencyKey(): string {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getIdempotencyKey(signature: string): string {
  try {
    const previous = JSON.parse(window.sessionStorage.getItem(IDEMPOTENCY_KEY) || '{}') as { key?: string; signature?: string };
    if (previous.key && previous.signature === signature) return previous.key;
    const key = createIdempotencyKey();
    window.sessionStorage.setItem(IDEMPOTENCY_KEY, JSON.stringify({ key, signature }));
    return key;
  } catch { return createIdempotencyKey(); }
}

function clearIdempotencyKey(): void {
  try { window.sessionStorage.removeItem(IDEMPOTENCY_KEY); } catch { /* Session storage may be unavailable. */ }
}

interface CouponQuote { code: string; discountAmount: number; cartSignature: string }
interface PayHereAvailability { enabled: boolean; mode?: 'sandbox' | 'live' }

function Field({ field, label, error, children }: { field: CheckoutField; label: string; error?: string; children: ReactNode }) {
  return <label className="zy-checkout-field" htmlFor={`checkout-${field}`}><span>{label}</span>{children}{error && <small id={`checkout-${field}-error`} role="alert">{error}</small>}</label>;
}

export default function PremiumCheckoutDrawer({
  isOpen, user, onClose, cartItems, onUpdateQuantity, onRemoveItem, onClearCart, settings, setCurrentPage,
}: CartDrawerProps) {
  const [form, setForm] = useState<CheckoutFormValues>(() => typeof window === 'undefined' ? EMPTY_CHECKOUT_FORM : readCheckoutDraft(window.sessionStorage));
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [couponError, setCouponError] = useState('');
  const [couponLoading, setCouponLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [copied, setCopied] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cod' | 'payhere'>('cod');
  const [payHereAvailability, setPayHereAvailability] = useState<PayHereAvailability>({ enabled: false });
  const [paymentOptionsLoading, setPaymentOptionsLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const appliedInitialAddressRef = useRef(false);
  const formHasAddressRef = useRef(Boolean(form.customerAddress));
  const isSubmittingRef = useRef(isSubmitting);
  const onCloseRef = useRef(onClose);

  const itemsSubtotal = useMemo(() => cartItems.reduce((sum, item) => sum + item.product.price * item.quantity, 0), [cartItems]);
  const cartSignature = useMemo(() => getCheckoutCartSignature(cartItems), [cartItems]);
  const baseDelivery = resolveDeliveryCharge(settings, form.district, DISTRICT_DELIVERY[form.district] ?? 500);
  const freeDeliveryThreshold = Math.max(0, settings?.freeDeliveryMin ?? 5000);
  const deliveryFee = itemsSubtotal > 0 && itemsSubtotal < freeDeliveryThreshold ? baseDelivery : 0;
  const discountAmount = couponQuote?.cartSignature === cartSignature ? couponQuote.discountAmount : 0;
  const grandTotal = Math.max(0, itemsSubtotal - discountAmount + deliveryFee);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmittingRef.current) onCloseRef.current();
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = (Array.from(panelRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')) as HTMLElement[])
        .filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  useEffect(() => { isSubmittingRef.current = isSubmitting; }, [isSubmitting]);
  useEffect(() => {
    onCloseRef.current = () => {
      if (placedOrder) setPlacedOrder(null);
      setCopied(false);
      onClose();
    };
  }, [onClose, placedOrder]);

  useEffect(() => {
    if (!isOpen || !user) { setAddresses([]); setAddressesLoading(false); return; }
    setAddressesLoading(true);
    return onSnapshot(collection(db, 'users', user.uid, 'addresses'), (snapshot) => {
      const next = sortCustomerAddresses(snapshot.docs.map(document => ({ id: document.id, ...document.data() } as CustomerAddress)));
      setAddresses(next);
      setAddressesLoading(false);
      const preferred = next.find(address => address.isDefault) || next[0];
      if (preferred && !appliedInitialAddressRef.current && !formHasAddressRef.current) {
        appliedInitialAddressRef.current = true;
        setSelectedAddressId(preferred.id);
        setForm(checkoutFormFromAddress(preferred, user.email || ''));
      }
    }, (error) => {
      reportClientIssue('checkout-addresses-load', error, 'warning');
      setAddressesLoading(false);
    });
  }, [isOpen, user]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setPaymentOptionsLoading(true);
    fetchJson<PayHereAvailability>('/api/payments/config', { method: 'POST' }, { fallbackMessage: 'Online payment availability could not be checked.' })
      .then(result => {
        if (!active) return;
        setPayHereAvailability(result);
        if (!result.enabled) setPaymentMethod('cod');
      })
      .catch(error => {
        if (active) { setPayHereAvailability({ enabled: false }); setPaymentMethod('cod'); }
        reportClientIssue('payhere-config', error, 'warning');
      })
      .finally(() => { if (active) setPaymentOptionsLoading(false); });
    return () => { active = false; };
  }, [isOpen]);

  useEffect(() => {
    if (!user) return;
    setForm(current => ({
      ...current,
      customerName: current.customerName || user.displayName || '',
      customerEmail: current.customerEmail || user.email || '',
    }));
  }, [user]);

  useEffect(() => {
    formHasAddressRef.current = Boolean(form.customerAddress);
    if (typeof window !== 'undefined') writeCheckoutDraft(window.sessionStorage, form);
  }, [form]);
  useEffect(() => {
    if (couponQuote && couponQuote.cartSignature !== cartSignature) {
      setCouponQuote(null);
      setCouponError('Your cart changed. Apply the coupon again to refresh the discount.');
    }
  }, [cartSignature, couponQuote]);
  useEffect(() => { if (placedOrder) window.requestAnimationFrame(() => confirmationHeadingRef.current?.focus()); }, [placedOrder]);

  if (!isOpen) return null;

  const updateField = (field: CheckoutField, value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    if (selectedAddressId && field !== 'customerEmail' && field !== 'customerPhone2') setSelectedAddressId('');
    setErrors(current => ({ ...current, [field]: undefined }));
    setCheckoutError('');
  };

  const applyAddress = (addressId: string) => {
    setSelectedAddressId(addressId);
    const address = addresses.find(item => item.id === addressId);
    if (address) { setForm(checkoutFormFromAddress(address, user?.email || form.customerEmail)); setErrors({}); }
  };

  const applyCoupon = async () => {
    if (!couponInput.trim() || couponLoading || cartItems.length === 0) return;
    setCouponLoading(true); setCouponError('');
    try {
      const result = await fetchJson<{ success: boolean; code: string; discountAmount: number }>('/api/checkout/coupon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ couponCode: couponInput, cartItems: cartItems.map(item => ({ productId: item.product.id, quantity: item.quantity })) }),
      }, { fallbackMessage: 'The coupon could not be checked right now.' });
      setCouponQuote({ code: result.code, discountAmount: result.discountAmount, cartSignature });
      setCouponInput(result.code);
    } catch (error) {
      reportClientIssue('checkout-coupon', error, 'warning');
      setCouponQuote(null);
      setCouponError(error instanceof Error ? error.message : 'The coupon could not be applied.');
    } finally { setCouponLoading(false); }
  };

  const handleCheckout = async (event: FormEvent) => {
    event.preventDefault();
    if (!cartItems.length || isSubmitting) return;
    const normalized = normalizeCheckoutForm(form);
    const nextErrors = validateCheckoutForm(normalized, { requireEmail: paymentMethod === 'payhere' });
    setForm(normalized); setErrors(nextErrors); setCheckoutError('');
    const firstError = Object.keys(nextErrors)[0] as CheckoutField | undefined;
    if (firstError) { document.getElementById(`checkout-${firstError}`)?.focus(); return; }

    setIsSubmitting(true);
    try {
      void trackCommerceEvent('begin_checkout', { currency: 'LKR', value: grandTotal, items: cartItems.length });
      const token = user ? await user.getIdToken() : '';
      const payload = {
        customerUid: user?.uid || 'guest', customerName: normalized.customerName, customerPhone: normalized.customerPhone,
        customerPhone2: normalized.customerPhone2, customerEmail: normalized.customerEmail || 'guest@zyro.lk',
        customerAddress: normalized.customerAddress, district: normalized.district, city: normalized.city,
        paymentMethod, couponCode: couponQuote?.code || '',
        cartItems: cartItems.map(item => ({ productId: item.product.id, quantity: item.quantity })),
      };
      const idempotencyKey = getIdempotencyKey(JSON.stringify(payload));
      const result = await fetchJson<{ success: boolean; order: Order; paymentSession?: PayHerePaymentSession; error?: string }>('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }, { fallbackMessage: 'Checkout is temporarily unavailable. Your cart is still saved.' });
      if (!result.success) throw new Error(result.error || 'The order could not be placed.');
      if (paymentMethod === 'payhere') {
        if (!result.paymentSession) throw new Error('The secure PayHere session was not returned. Your reserved order remains available for retry.');
        void trackCommerceEvent('add_payment_info', { currency: 'LKR', value: result.order.totalPrice, payment_type: 'payhere' });
        submitPayHerePayment(result.paymentSession);
      } else {
        setPlacedOrder(result.order);
        trackPurchaseOnce(result.order.id, result.order.totalPrice, 'cod', result.order.couponCode);
      }
      clearIdempotencyKey();
      clearCheckoutDraft(window.sessionStorage);
      onClearCart();
    } catch (error) {
      reportClientIssue('checkout-request', error, 'warning');
      setCheckoutError(error instanceof Error ? error.message : 'The order could not be placed. Your cart remains saved.');
    } finally { setIsSubmitting(false); }
  };

  const copyReference = async () => {
    if (!placedOrder) return;
    const reference = placedOrder.orderNumber || placedOrder.id;
    try { await navigator.clipboard.writeText(reference); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
  };

  const sendWhatsApp = (order: Order) => {
    const number = (settings?.whatsappNumber || '').replace(/\D/gu, '');
    if (!number) return;
    const reference = order.orderNumber || order.id.slice(0, 8).toUpperCase();
    const message = encodeURIComponent(`Hello Zyro.lk, I placed order ${reference} for ${formatPrice(order.totalPrice)}. Please confirm my Cash on Delivery order.`);
    window.open(`https://wa.me/${number}?text=${message}`, '_blank', 'noopener,noreferrer');
  };

  const orderSubtotal = placedOrder?.itemsSubtotal ?? placedOrder?.items.reduce((sum, item) => sum + item.price * item.quantity, 0) ?? 0;
  const orderDiscount = placedOrder?.discountAmount ?? 0;
  const orderDelivery = placedOrder?.deliveryFee ?? Math.max(0, (placedOrder?.totalPrice || 0) - orderSubtotal + orderDiscount);

  return <div className="zy-checkout-overlay" role="dialog" aria-modal="true" aria-labelledby={placedOrder ? 'checkout-confirmation-title' : 'premium-checkout-title'}>
    <div ref={panelRef} className="zy-premium-checkout">
      <header className="zy-premium-checkout-header">
        <div><span><ShieldCheck aria-hidden="true" /> Secure checkout</span><h2 id="premium-checkout-title">{placedOrder ? 'Order confirmed' : 'Complete your order'}</h2></div>
        {!placedOrder && <ol aria-label="Checkout progress"><li className="is-active"><b>1</b>Cart</li><li className="is-active"><b>2</b>Delivery</li><li><b>3</b>Confirmation</li></ol>}
        <button ref={closeButtonRef} type="button" onClick={() => onCloseRef.current()} disabled={isSubmitting} aria-label="Close checkout"><X aria-hidden="true" /></button>
      </header>

      {placedOrder ? <main className="zy-order-confirmation">
        <div className="zy-confirmation-hero"><span><CheckCircle2 aria-hidden="true" /></span><p>Order received</p><h1 id="checkout-confirmation-title" ref={confirmationHeadingRef} tabIndex={-1}>Thank you, {placedOrder.customerName}</h1><small>We’ll contact you to confirm the Cash on Delivery dispatch.</small></div>
        <div className="zy-confirmation-reference"><div><small>Order reference</small><strong>{placedOrder.orderNumber || placedOrder.id.slice(0, 8).toUpperCase()}</strong></div><button type="button" onClick={copyReference}><Copy aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button></div>
        <div className="zy-confirmation-grid">
          <section><h3><MapPin aria-hidden="true" />Delivery</h3><strong>{placedOrder.customerName}</strong><p>{placedOrder.customerAddress}<br />{placedOrder.city}, {placedOrder.district}<br />{placedOrder.customerPhone}</p></section>
          <section><h3><PackageCheck aria-hidden="true" />Items</h3>{placedOrder.items.map(item => <div key={item.productId}><span>{item.name} × {item.quantity}</span><b>{formatPrice(item.price * item.quantity)}</b></div>)}</section>
          <section className="zy-confirmation-totals"><h3><CircleDollarSign aria-hidden="true" />Payment summary</h3><div><span>Subtotal</span><b>{formatPrice(orderSubtotal)}</b></div>{orderDiscount > 0 && <div className="is-discount"><span>Coupon {placedOrder.couponCode ? `(${placedOrder.couponCode})` : ''}</span><b>−{formatPrice(orderDiscount)}</b></div>}<div><span>Delivery</span><b>{orderDelivery === 0 ? 'Free' : formatPrice(orderDelivery)}</b></div><div className="is-total"><span>Cash on Delivery total</span><b>{formatPrice(placedOrder.totalPrice)}</b></div></section>
        </div>
        <div className="zy-confirmation-actions">{user && <button type="button" onClick={() => { setPlacedOrder(null); onClose(); setCurrentPage?.('account-orders'); }}><PackageCheck aria-hidden="true" />View My Orders</button>}{settings?.whatsappNumber && <button type="button" onClick={() => sendWhatsApp(placedOrder)}><Phone aria-hidden="true" />WhatsApp confirmation</button>}<button type="button" onClick={() => { setPlacedOrder(null); onClose(); }}><ShoppingBag aria-hidden="true" />Continue shopping</button></div>
      </main> : <form className="zy-checkout-layout" onSubmit={handleCheckout} noValidate>
        <section className="zy-checkout-cart-column" aria-labelledby="checkout-cart-heading">
          <div className="zy-checkout-section-heading"><div><small>Step 1</small><h3 id="checkout-cart-heading">Your cart</h3></div><span>{cartItems.length} {cartItems.length === 1 ? 'item' : 'items'}</span></div>
          {cartItems.length === 0 ? <div className="zy-checkout-empty"><ShoppingBag aria-hidden="true" /><strong>Your cart is empty</strong><p>Add a product before starting checkout.</p><button type="button" onClick={onClose}>Continue shopping</button></div> : <div className="zy-checkout-items">{cartItems.map(item => <article key={item.product.id}><img src={item.product.imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /><div><strong>{item.product.name}</strong><small>{formatPrice(item.product.price)} each</small><span><button type="button" onClick={() => onUpdateQuantity(item.product.id, Math.max(1, item.quantity - 1))} disabled={item.quantity <= 1} aria-label={`Decrease ${item.product.name}`}><Minus /></button><b aria-live="polite">{item.quantity}</b><button type="button" onClick={() => onUpdateQuantity(item.product.id, Math.min(item.product.stock, item.quantity + 1))} disabled={item.quantity >= item.product.stock} aria-label={`Increase ${item.product.name}`}><Plus /></button></span></div><aside><b>{formatPrice(item.product.price * item.quantity)}</b><button type="button" onClick={() => onRemoveItem(item.product.id)} aria-label={`Remove ${item.product.name}`}><Trash2 /></button></aside></article>)}</div>}

          {cartItems.length > 0 && <><div className="zy-delivery-progress"><div><Truck aria-hidden="true" /><span>{itemsSubtotal >= freeDeliveryThreshold ? <><b>Free delivery unlocked</b><small>Your order qualifies for islandwide delivery.</small></> : <><b>{formatPrice(freeDeliveryThreshold - itemsSubtotal)} away from free delivery</b><small>Keep shopping or continue with the current delivery fee.</small></>}</span></div><i><b style={{ width: `${freeDeliveryThreshold <= 0 ? 100 : Math.min(100, (itemsSubtotal / freeDeliveryThreshold) * 100)}%` }} /></i></div>
          <div className="zy-coupon-card"><div><BadgePercent aria-hidden="true" /><span><b>Have a coupon?</b><small>Codes are validated securely against the live order subtotal.</small></span></div><div><input value={couponInput} onChange={event => { setCouponInput(event.target.value.toUpperCase()); setCouponError(''); }} maxLength={40} placeholder="Enter coupon code" aria-label="Coupon code" aria-describedby={couponError ? 'coupon-error' : undefined} /><button type="button" onClick={applyCoupon} disabled={couponLoading || !couponInput.trim()}>{couponLoading ? <LoaderCircle className="is-spinning" /> : couponQuote ? 'Reapply' : 'Apply'}</button></div>{couponQuote && <p className="is-success"><Check />Coupon {couponQuote.code} applied: save {formatPrice(couponQuote.discountAmount)} <button type="button" onClick={() => { setCouponQuote(null); setCouponInput(''); }}>Remove</button></p>}{couponError && <p id="coupon-error" className="is-error" role="alert">{couponError}</p>}</div></>}
        </section>

        <section className="zy-checkout-details-column" aria-labelledby="checkout-delivery-heading">
          <div className="zy-checkout-section-heading"><div><small>Step 2</small><h3 id="checkout-delivery-heading">Delivery details</h3></div><span><LockKeyhole />Private &amp; secure</span></div>
          {user ? <div className="zy-saved-addresses"><label htmlFor="checkout-saved-address"><Home />Saved address</label>{addressesLoading ? <div className="zy-address-skeleton" aria-label="Loading saved addresses" role="status" /> : addresses.length ? <select id="checkout-saved-address" value={selectedAddressId} onChange={event => applyAddress(event.target.value)}><option value="">Enter another address</option>{addresses.map(address => <option value={address.id} key={address.id}>{address.label}{address.isDefault ? ' — Default' : ''}</option>)}</select> : <p>No saved addresses yet. Enter delivery details below or add one in My Account.</p>}</div> : <div className="zy-checkout-guest-note"><MapPin /><span><b>Checking out as guest</b><small>Your cart stays saved on this device if you close checkout.</small></span></div>}

          <div className="zy-checkout-fields">
            <Field field="customerName" label="Recipient name" error={errors.customerName}><input id="checkout-customerName" value={form.customerName} onChange={event => updateField('customerName', event.target.value)} maxLength={120} autoComplete="name" aria-invalid={Boolean(errors.customerName)} aria-describedby={errors.customerName ? 'checkout-customerName-error' : undefined} /></Field>
            <Field field="customerPhone" label="Phone number" error={errors.customerPhone}><input id="checkout-customerPhone" value={form.customerPhone} onChange={event => updateField('customerPhone', event.target.value)} maxLength={30} inputMode="tel" autoComplete="tel" aria-invalid={Boolean(errors.customerPhone)} aria-describedby={errors.customerPhone ? 'checkout-customerPhone-error' : undefined} /></Field>
            <Field field="customerPhone2" label="Alternative phone (optional)" error={errors.customerPhone2}><input id="checkout-customerPhone2" value={form.customerPhone2} onChange={event => updateField('customerPhone2', event.target.value)} maxLength={30} inputMode="tel" autoComplete="tel-national" aria-invalid={Boolean(errors.customerPhone2)} aria-describedby={errors.customerPhone2 ? 'checkout-customerPhone2-error' : undefined} /></Field>
            <Field field="customerEmail" label="Email (optional)" error={errors.customerEmail}><input id="checkout-customerEmail" type="email" value={form.customerEmail} onChange={event => updateField('customerEmail', event.target.value)} maxLength={160} autoComplete="email" aria-invalid={Boolean(errors.customerEmail)} aria-describedby={errors.customerEmail ? 'checkout-customerEmail-error' : undefined} /></Field>
            <Field field="district" label="District" error={errors.district}><select id="checkout-district" value={form.district} onChange={event => updateField('district', event.target.value)} autoComplete="address-level1" aria-invalid={Boolean(errors.district)}>{SRI_LANKA_DISTRICTS.map(district => <option key={district}>{district}</option>)}</select></Field>
            <Field field="city" label="City" error={errors.city}><input id="checkout-city" value={form.city} onChange={event => updateField('city', event.target.value)} maxLength={80} autoComplete="address-level2" aria-invalid={Boolean(errors.city)} aria-describedby={errors.city ? 'checkout-city-error' : undefined} /></Field>
            <Field field="customerAddress" label="Street address" error={errors.customerAddress}><textarea id="checkout-customerAddress" value={form.customerAddress} onChange={event => updateField('customerAddress', event.target.value)} maxLength={500} rows={3} autoComplete="street-address" aria-invalid={Boolean(errors.customerAddress)} aria-describedby={errors.customerAddress ? 'checkout-customerAddress-error' : undefined} /></Field>
          </div>

          <fieldset className="zy-payment-options"><legend>Payment method</legend><label className={paymentMethod === 'cod' ? 'is-selected' : ''}><input type="radio" name="paymentMethod" value="cod" checked={paymentMethod === 'cod'} onChange={() => setPaymentMethod('cod')} /><ShieldCheck /><span><b>Cash on Delivery</b><small>Pay when your confirmed order arrives.</small></span><CheckCircle2 /></label>{paymentOptionsLoading ? <div className="zy-payment-option-skeleton" role="status" aria-label="Checking online payment availability" /> : payHereAvailability.enabled && <label className={paymentMethod === 'payhere' ? 'is-selected' : ''}><input type="radio" name="paymentMethod" value="payhere" checked={paymentMethod === 'payhere'} onChange={() => setPaymentMethod('payhere')} /><CircleDollarSign /><span><b>Pay securely with PayHere</b><small>Cards and supported local payment methods{payHereAvailability.mode === 'sandbox' ? ' - Sandbox mode' : ''}.</small></span><CheckCircle2 /></label>}</fieldset>
          <aside className="zy-checkout-summary" aria-labelledby="checkout-summary-title"><h3 id="checkout-summary-title">Order summary</h3><div><span>Items subtotal</span><b>{formatPrice(itemsSubtotal)}</b></div>{discountAmount > 0 && <div className="is-discount"><span>Coupon discount</span><b>−{formatPrice(discountAmount)}</b></div>}<div><span>Delivery to {form.district}</span><b>{deliveryFee === 0 ? 'Free' : formatPrice(deliveryFee)}</b></div><div className="is-total"><span>Total payable</span><b>{formatPrice(grandTotal)}</b></div></aside>
          {checkoutError && <div className="zy-checkout-error" role="alert">{checkoutError}<small>Your cart and delivery draft are still saved.</small></div>}
          <button className="zy-place-order" type="submit" disabled={isSubmitting || cartItems.length === 0} aria-busy={isSubmitting}>{isSubmitting ? <><LoaderCircle className="is-spinning" />{paymentMethod === 'payhere' ? 'Preparing PayHere…' : 'Placing your order securely…'}</> : <><LockKeyhole />{paymentMethod === 'payhere' ? 'Continue to PayHere' : 'Place COD order'} · {formatPrice(grandTotal)}<ChevronRight /></>}</button>
          <p className="zy-checkout-assurance"><LockKeyhole />Prices, coupons, stock, delivery, and totals are verified again by the secure checkout service.</p>
        </section>
      </form>}
    </div>
  </div>;
}
