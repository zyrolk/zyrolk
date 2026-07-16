import React, { useEffect, useRef, useState } from 'react';
import { X, ShoppingBag, Trash2, ShieldCheck, Phone, CheckCircle, Truck, Lock, Eye } from 'lucide-react';
import { CartItem, Order, WebsiteSettings } from '../types';
import { auth } from '../firebase';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  settings?: WebsiteSettings | null;
  setCurrentPage?: (page: string) => void;
}

const DISTRICT_DELIVERY: Record<string, number> = {
  "Colombo": 350,
  "Gampaha": 450,
  "Kalutara": 450,
  "Kandy": 550,
  "Galle": 550,
  "Matara": 550,
  "Jaffna": 650,
  "Kurunegala": 500,
  "Anuradhapura": 600,
  "Badulla": 600,
  "Ratnapura": 500,
  "Batticaloa": 650,
  "Trincomalee": 650,
  "Other": 600
};

const CHECKOUT_IDEMPOTENCY_STORAGE_KEY = "zyro.checkout.idempotency";

function createCheckoutIdempotencyKey() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getCheckoutIdempotencyKey(signature: string) {
  try {
    const storedAttempt = window.sessionStorage.getItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
    if (storedAttempt) {
      const parsedAttempt = JSON.parse(storedAttempt) as { key?: string; signature?: string };
      if (parsedAttempt.key && parsedAttempt.signature === signature) {
        return parsedAttempt.key;
      }
    }

    const key = createCheckoutIdempotencyKey();
    window.sessionStorage.setItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key, signature }));
    return key;
  } catch {
    return createCheckoutIdempotencyKey();
  }
}

function clearCheckoutIdempotencyKey() {
  try {
    window.sessionStorage.removeItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
  } catch {
    // Ignore browsers that block session storage.
  }
}

export default function CartDrawer({
  isOpen,
  onClose,
  cartItems,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  settings,
  setCurrentPage
}: CartDrawerProps) {
  // Checkout form states
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerPhone2, setCustomerPhone2] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("Colombo");
  const paymentMethod: 'cod' | 'whatsapp_confirm' = 'cod';
  
  // Checkout submission states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleEscape);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // Calculate prices using custom Settings or default District Delivery rates
  const itemsSubtotal = cartItems.reduce((acc, item) => acc + (item.product.price * item.quantity), 0);
  
  // Determine delivery charge based on WebsiteSettings
  const baseDeliveryCharge = settings?.deliveryCharge !== undefined 
    ? settings.deliveryCharge 
    : (DISTRICT_DELIVERY[district] || 500);

  const freeDeliveryThreshold = settings?.freeDeliveryMin !== undefined 
    ? settings.freeDeliveryMin 
    : 5000; // default free delivery threshold

  const isEligibleForFreeDelivery = itemsSubtotal >= freeDeliveryThreshold;
  const deliveryFee = itemsSubtotal > 0 
    ? (isEligibleForFreeDelivery ? 0 : baseDeliveryCharge) 
    : 0;

  const grandTotal = itemsSubtotal + deliveryFee;

  // Format currency
  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency: 'LKR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  const handleSendWhatsAppOrder = (order: Order) => {
    const whatsappNum = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9]/g, "") 
      : "";
    if (!whatsappNum) return;

    const itemsText = order.items.map(item => `- ${item.name} (Qty: ${item.quantity}) - LKR ${item.price * item.quantity}`).join('\n');
    const message = encodeURIComponent(
      `*New Order placed at Zyro.lk!*\n\n` +
      `*Order ID:* #${order.id.substring(0, 8).toUpperCase()}\n` +
      `*Name:* ${order.customerName}\n` +
      `*Phone:* ${order.customerPhone}\n` +
      `*Delivery Address:* ${order.customerAddress}, ${order.city}, ${order.district}\n\n` +
      `*Items:*\n${itemsText}\n\n` +
      `*Total Price:* LKR ${order.totalPrice}\n\n` +
      `Please confirm my order. Thank you!`
    );
    window.open(`https://wa.me/${whatsappNum}?text=${message}`, '_blank');
  };

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cartItems.length === 0) return;

    setIsSubmitting(true);
    setCheckoutError(null);
    try {
      const user = auth.currentUser;
      const checkoutPayload = {
        customerUid: user ? user.uid : "guest",
        customerName,
        customerPhone,
        customerPhone2: customerPhone2 || "",
        customerEmail: customerEmail || "guest@zyro.lk",
        customerAddress,
        district,
        city,
        paymentMethod,
        cartItems: cartItems.map(item => ({
          productId: item.product.id,
          quantity: item.quantity
        }))
      };
      const idempotencyKey = getCheckoutIdempotencyKey(JSON.stringify(checkoutPayload));
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          ...checkoutPayload,
          idempotencyKey,
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to process checkout on the server.");
      }

      const resData = await response.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to process checkout on the server.");
      }

      setPlacedOrder(resData.order);
      clearCheckoutIdempotencyKey();

      // Reset & Clear
      onClearCart();
    } catch (err: any) {
      console.error("Checkout failed:", err);
      setCheckoutError(err.message || "An unexpected error occurred during checkout.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="zy-overlay fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-xs flex justify-end" role="dialog" aria-modal="true" aria-labelledby="cart-drawer-title">
      
      {/* Cart Container */}
      <div className="zy-cart-drawer w-full max-w-lg bg-white h-[100dvh] flex flex-col justify-between animate-slideLeft overflow-hidden">
        
        {/* Header */}
        <div className="zy-cart-header flex flex-none items-center justify-between border-b border-blue-400/20 bg-gradient-to-r from-blue-800 via-brand-blue to-blue-500 px-4 py-4 text-white sm:px-6 sm:py-5">
          <div className="flex items-center space-x-2">
            <ShoppingBag className="h-5 w-5 text-white" />
            <h2 id="cart-drawer-title" className="text-lg font-bold tracking-tight font-display text-white">Shopping Cart</h2>
            <span className="rounded-full border border-white/20 bg-white/15 px-2 py-0.5 text-xs font-bold text-white">
              {cartItems.length}
            </span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20 cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
            aria-label="Close shopping cart"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {placedOrder ? (
          /* Order success stage */
          <div className="flex-1 p-8 text-center flex flex-col items-center justify-center space-y-6">
            <CheckCircle className="h-16 w-16 text-emerald-500 animate-bounce" />
            <h3 className="text-2xl font-bold font-display text-slate-900">Order Placed Successfully!</h3>
            <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 w-full text-left space-y-2">
              <p className="text-xs text-slate-500">Order Reference ID:</p>
              <p className="text-sm font-mono font-bold text-slate-800 bg-slate-200/50 p-2 rounded-lg">{placedOrder.id}</p>
              <p className="text-xs text-slate-500 mt-2">Customer Details:</p>
              <p className="text-sm font-medium text-slate-700">
                {placedOrder.customerName} ({placedOrder.customerPhone}
                {placedOrder.customerPhone2 ? `, ${placedOrder.customerPhone2}` : ""})
              </p>
              {placedOrder.city && (
                <>
                  <p className="text-xs text-slate-500 mt-2">City:</p>
                  <p className="text-sm font-semibold text-slate-700">{placedOrder.city}</p>
                </>
              )}
              <p className="text-xs text-slate-500 mt-2">Delivery Charge (to {placedOrder.district}):</p>
              <p className="text-sm font-semibold text-slate-700">{formatPrice(deliveryFee)}</p>
              <p className="text-xs text-slate-500 mt-2">Grand Total:</p>
              <p className="text-base font-bold text-slate-900">{formatPrice(placedOrder.totalPrice)}</p>
            </div>
            <p className="text-sm text-slate-500 font-light">
              We have received your order request. Our support team will contact you shortly to confirm your Cash on Delivery dispatch details.
            </p>
            <div className="flex flex-col gap-2.5 w-full">
              {settings?.whatsappNumber && (
                <button
                  onClick={() => handleSendWhatsAppOrder(placedOrder)}
                  className="w-full py-3.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm cursor-pointer transition-all flex items-center justify-center gap-1.5"
                >
                  <Phone className="h-4 w-4 text-white" />
                  Notify via WhatsApp
                </button>
              )}
              <button
                onClick={() => {
                  setPlacedOrder(null);
                  onClose();
                }}
                className="w-full py-3 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-bold text-sm cursor-pointer transition-all"
              >
                Continue Shopping
              </button>
            </div>
          </div>
        ) : (
          /* Cart active items list & Checkout Form */
          <>
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] space-y-6 sm:px-6">
              
              {/* Free Delivery Progress Bar */}
              {cartItems.length > 0 && (() => {
                const percent = Math.min(100, (itemsSubtotal / freeDeliveryThreshold) * 100);
                const neededAmount = freeDeliveryThreshold - itemsSubtotal;
                return (
                  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 space-y-2.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-semibold text-slate-700">
                        {isEligibleForFreeDelivery ? (
                          <span className="text-emerald-600 flex items-center gap-1.5 font-bold">
                            Free islandwide delivery unlocked!
                          </span>
                        ) : (
                          <span>
                            Add <strong className="text-slate-900">{formatPrice(neededAmount)}</strong> more for <strong className="text-brand-blue font-bold">FREE Delivery</strong>
                          </span>
                        )}
                      </span>
                      <span className="text-slate-400 font-mono text-[10px] font-bold">
                        {Math.round(percent)}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ease-out rounded-full ${
                          isEligibleForFreeDelivery ? "bg-emerald-500" : "bg-brand-blue"
                        }`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                );
              })()}
              
              {/* Cart Items List */}
              {cartItems.length === 0 ? (
                <div className="text-center py-16 text-slate-500 space-y-4">
                  <ShoppingBag className="h-12 w-12 mx-auto text-slate-300" />
                  <p className="text-base font-black font-display text-slate-900">Your shopping cart is empty</p>
                  <p className="mx-auto max-w-xs text-xs leading-relaxed text-slate-500">Discover products across every live collection and add your favourites when you are ready.</p>
                  <button
                    type="button"
                    onClick={onClose}
                    className="min-h-11 rounded-xl px-4 text-xs font-bold text-brand-blue hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                  >
                    Explore the marketplace
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Cart Items</h4>
                  <div className="divide-y divide-slate-100">
                    {cartItems.map((item) => (
                      <div key={item.product.id} className="zy-cart-item flex items-start py-4 first:pt-0 last:pb-0">
                        <img
                          src={item.product.imageUrl}
                          alt={item.product.name}
                          className="h-18 w-18 rounded-2xl object-contain p-2 bg-slate-50 border border-slate-100 flex-shrink-0"
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          decoding="async"
                          width="56"
                          height="56"
                        />
                        <div className="ml-3 min-w-0 flex-1 text-left sm:ml-4">
                          <h5 className="text-sm font-semibold text-slate-800 line-clamp-1">{item.product.name}</h5>
                          <span className="text-xs text-slate-500">{formatPrice(item.product.price)} each</span>
                          <div className="flex items-center space-x-1.5 mt-1.5">
                            <button
                              type="button"
                              onClick={() => onUpdateQuantity(item.product.id, Math.max(1, item.quantity - 1))}
                              className="w-11 h-11 rounded-xl bg-slate-100 text-slate-700 font-black text-base flex items-center justify-center cursor-pointer transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                              disabled={item.quantity <= 1}
                              aria-label={`Decrease quantity of ${item.product.name}`}
                            >
                              -
                            </button>
                            <span className="flex h-11 w-8 items-center justify-center text-sm font-black" aria-live="polite">{item.quantity}</span>
                            <button
                              type="button"
                              onClick={() => onUpdateQuantity(item.product.id, Math.min(item.product.stock, item.quantity + 1))}
                              className="w-11 h-11 rounded-xl bg-slate-100 text-slate-700 font-black text-base flex items-center justify-center cursor-pointer transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                              disabled={item.quantity >= item.product.stock}
                              aria-label={`Increase quantity of ${item.product.name}`}
                            >
                              +
                            </button>
                          </div>
                        </div>
                        <div className="ml-2 flex h-[4.5rem] flex-col items-end justify-between sm:ml-4">
                          <span className="text-sm font-bold text-slate-900">
                            {formatPrice(item.product.price * item.quantity)}
                          </span>
                          <button
                            type="button"
                            onClick={() => onRemoveItem(item.product.id)}
                            className="flex h-11 w-11 items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/20"
                            title="Remove item"
                            aria-label={`Remove ${item.product.name} from cart`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Delivery and Summary Box */}
              {cartItems.length > 0 && (
                <div className="zy-cart-summary bg-slate-50 border border-slate-100 p-5 rounded-3xl space-y-3.5">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Order Summary</h4>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Items Subtotal:</span>
                      <span className="font-semibold text-slate-800">{formatPrice(itemsSubtotal)}</span>
                    </div>
                    
                    <div className="flex justify-between">
                      <span className="text-slate-500">Delivery Fee (District: {district}):</span>
                      <span className="font-semibold text-slate-800">
                        {isEligibleForFreeDelivery ? (
                          <span className="text-emerald-600 font-black">FREE (Promo)</span>
                        ) : (
                          formatPrice(deliveryFee)
                        )}
                      </span>
                    </div>

                    {isEligibleForFreeDelivery && (
                      <div className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg text-center">
                        Free delivery threshold of {formatPrice(freeDeliveryThreshold)} reached.
                      </div>
                    )}

                    <div className="flex justify-between text-sm font-bold pt-2 border-t border-slate-200">
                      <span className="text-slate-900">Total Payable:</span>
                      <span className="text-brand-blue font-black">{formatPrice(grandTotal)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Checkout Form */}
              {cartItems.length > 0 && (
                <form onSubmit={handleCheckout} className="zy-checkout-form space-y-4">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Delivery Details</h4>
                  
                  <div className="grid grid-cols-1 gap-3.5">
                    
                    {/* Customer Name */}
                    <div>
                      <label htmlFor="cart-recipient-name" className="block text-xs font-medium text-slate-600 mb-1">Recipient Name *</label>
                      <input
                        id="cart-recipient-name"
                        type="text"
                        required
                        placeholder="Enter recipient name"
                        value={customerName}
                        onChange={(e) => setCustomerName(e.target.value)}
                        className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      />
                    </div>

                    {/* Customer Phone 1 (Required) */}
                    <div>
                      <label htmlFor="cart-phone-primary" className="block text-xs font-medium text-slate-600 mb-1">Phone Number 1 *</label>
                      <input
                        id="cart-phone-primary"
                        type="tel"
                        required
                        placeholder="+94 77 123 4567"
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value)}
                        className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      />
                    </div>

                    {/* Customer Phone 2 (Optional) */}
                    <div>
                      <label htmlFor="cart-phone-secondary" className="block text-xs font-medium text-slate-600 mb-1">Phone Number 2 (Optional)</label>
                      <input
                        id="cart-phone-secondary"
                        type="tel"
                        placeholder="Alternative Contact Number"
                        value={customerPhone2}
                        onChange={(e) => setCustomerPhone2(e.target.value)}
                        className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      />
                    </div>

                    {/* Email */}
                    <div>
                      <label htmlFor="cart-email" className="block text-xs font-medium text-slate-600 mb-1">Email Address (Optional)</label>
                      <input
                        id="cart-email"
                        type="email"
                        placeholder="customer@gmail.com"
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                        className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      />
                    </div>

                    {/* District Selector for Sri Lanka */}
                    <div>
                      <label htmlFor="cart-district" className="block text-xs font-medium text-slate-600 mb-1">District *</label>
                      <select
                        id="cart-district"
                        value={district}
                        onChange={(e) => setDistrict(e.target.value)}
                        className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      >
                        {Object.keys(DISTRICT_DELIVERY).map((dist) => (
                          <option key={dist} value={dist}>{dist}</option>
                        ))}
                      </select>
                    </div>

                    {/* City */}
                    <div>
                      <label htmlFor="cart-city" className="block text-xs font-medium text-slate-600 mb-1">City *</label>
                      <input
                        id="cart-city"
                        type="text"
                        required
                        placeholder="Colombo"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      />
                    </div>

                    {/* Delivery Address */}
                    <div>
                      <label htmlFor="cart-address" className="block text-xs font-medium text-slate-600 mb-1">Street Address *</label>
                      <textarea
                        id="cart-address"
                        required
                        rows={2}
                        placeholder="No. 12, Galle Road, Colombo 03"
                        value={customerAddress}
                        onChange={(e) => setCustomerAddress(e.target.value)}
                        className="w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                      ></textarea>
                    </div>

                    {/* Cash on Delivery Only Info */}
                    <div className="bg-slate-50 border border-slate-100 p-3.5 rounded-xl flex items-center space-x-3">
                      <div className="p-2 bg-slate-900 text-white rounded-lg">
                        <ShieldCheck className="h-5 w-5" />
                      </div>
                      <div>
                        <span className="text-xs font-bold text-slate-900 block">Payment Method</span>
                        <span className="text-[10px] text-slate-500">Cash on Delivery (COD) ONLY</span>
                      </div>
                    </div>

                  </div>

                  {checkoutError && (
                    <div className="p-3.5 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl font-semibold leading-relaxed">
                      ⚠️ {checkoutError}
                    </div>
                  )}

                  {/* Professional Trust Box */}
                  <div className="grid grid-cols-2 gap-3 bg-slate-50 border border-slate-100 p-4 rounded-xl text-left">
                    <div className="flex items-start space-x-2">
                      <Truck className="h-4 w-4 text-brand-blue mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-[11px] font-bold text-slate-800 block">Islandwide Delivery</span>
                        <span className="text-[9px] text-slate-500 leading-tight block">Delivered to your doorstep</span>
                      </div>
                    </div>
                    <div className="flex items-start space-x-2">
                      <Lock className="h-4 w-4 text-brand-blue mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-[11px] font-bold text-slate-800 block">Secure Checkout</span>
                        <span className="text-[9px] text-slate-500 leading-tight block">Verified order processing</span>
                      </div>
                    </div>
                    <div className="flex items-start space-x-2">
                      <ShieldCheck className="h-4 w-4 text-brand-blue mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-[11px] font-bold text-slate-800 block">Cash on Delivery</span>
                        <span className="text-[9px] text-slate-500 leading-tight block">Pay only when you receive</span>
                      </div>
                    </div>
                    <div className="flex items-start space-x-2">
                      <Eye className="h-4 w-4 text-brand-blue mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-[11px] font-bold text-slate-800 block">Inspect on Delivery</span>
                        <span className="text-[9px] text-slate-500 leading-tight block">Verify items before you pay</span>
                      </div>
                    </div>
                  </div>

                  {/* Submission CTA */}
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="min-h-12 w-full mt-6 py-3.5 px-4 rounded-xl font-bold text-sm cursor-pointer transition-all flex items-center justify-center bg-slate-900 hover:bg-slate-800 text-white shadow-lg shadow-slate-900/10 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                    aria-busy={isSubmitting}
                  >
                    {isSubmitting ? (
                      "Saving Order details..."
                    ) : (
                      <>
                        <ShieldCheck className="h-4 w-4 mr-1.5 text-white" />
                        Place Cash On Delivery Order ({formatPrice(grandTotal)})
                      </>
                    )}
                  </button>
                </form>
              )}

            </div>
          </>
        )}

      </div>
    </div>
  );
}
