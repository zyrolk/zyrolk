import { useEffect, useState } from 'react';
import { LoaderCircle, PackageCheck, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { fetchJson, NetworkRequestError } from '../../services/network/fetchJson';
import {
  clearGuestOrderRecoveryToken,
  readGuestOrderRecoveryCandidates,
} from './guestOrderRecovery';

interface GuestOrderTrackingItem {
  name: string;
  imageUrl: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

interface GuestOrderTrackingShipment {
  status: 'shipped' | 'delivered';
  courier: string;
  trackingNumber: string;
  trackingUrl: string | null;
  shippedAt: string;
  deliveredAt: string | null;
}

interface GuestOrderTrackingOrder {
  orderNumber: string;
  placedAt: string;
  status: string;
  items: GuestOrderTrackingItem[];
  itemsSubtotal: number;
  discount: number;
  deliveryFee: number;
  totalPrice: number;
  shipments: GuestOrderTrackingShipment[];
}

interface GuestOrderTrackingPageProps {
  onNavigate: (page: string) => void;
}

export const GUEST_ORDER_TRACKING_FAILURE = 'Order details could not be verified.';

const isGenericCredentialFailure = (error: unknown): boolean => {
  if (!(error instanceof NetworkRequestError)
    || error.kind !== 'http'
    || error.status !== 401
    || !error.body
    || typeof error.body !== 'object') return false;
  return (error.body as { error?: unknown }).error === GUEST_ORDER_TRACKING_FAILURE;
};

export async function fetchGuestOrderWithFallback(
  candidates: string[],
  request: (token: string) => Promise<GuestOrderTrackingOrder>,
): Promise<GuestOrderTrackingOrder> {
  const orderedCandidates = [...new Set(candidates)];
  let lastError: unknown;
  for (const [index, candidate] of orderedCandidates.entries()) {
    try {
      return await request(candidate);
    } catch (error) {
      lastError = error;
      if (!isGenericCredentialFailure(error) || index === orderedCandidates.length - 1) throw error;
    }
  }
  throw lastError || new NetworkRequestError(GUEST_ORDER_TRACKING_FAILURE, 'http', 401, { error: GUEST_ORDER_TRACKING_FAILURE });
}

const formatPrice = (value: number): string => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(value);

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently placed' : date.toLocaleString('en-LK', { dateStyle: 'medium', timeStyle: 'short' });
};

export default function GuestOrderTrackingPage({ onNavigate }: GuestOrderTrackingPageProps) {
  const [candidates, setCandidates] = useState<string[]>(() => readGuestOrderRecoveryCandidates());
  const [order, setOrder] = useState<GuestOrderTrackingOrder | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(candidates.length > 0);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (!candidates.length) {
      setLoading(false);
      setOrder(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    void fetchGuestOrderWithFallback(candidates, (candidate) => fetchJson<{ success: true; order: GuestOrderTrackingOrder }>('/api/orders/guest-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recoveryToken: candidate }),
    }, { fallbackMessage: GUEST_ORDER_TRACKING_FAILURE }).then(result => result.order))
      .then(result => { if (active) setOrder(result); })
      .catch((requestError: unknown) => {
        if (!active) return;
        setOrder(null);
        setError(requestError instanceof NetworkRequestError && requestError.status === 429
          ? 'Please wait a moment before trying again.'
          : GUEST_ORDER_TRACKING_FAILURE);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [candidates, retryVersion]);

  const forgetOrder = () => {
    clearGuestOrderRecoveryToken();
    setCandidates([]);
    setOrder(null);
    setError('');
  };

  return (
    <section className="mx-auto my-10 w-full max-w-4xl px-4 sm:px-6 lg:px-8" aria-labelledby="guest-order-tracking-title">
      <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-brand-blue"><PackageCheck aria-hidden="true" /></div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-blue">Guest order recovery</p>
            <h1 id="guest-order-tracking-title" className="mt-2 text-3xl font-bold text-slate-900">Track your order</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">This page uses the secure recovery saved on this device. No order number or phone number is required.</p>
          </div>
        </div>

        {loading && <div className="mt-10 flex items-center gap-3 text-sm text-slate-600" role="status" aria-live="polite"><LoaderCircle className="animate-spin" aria-hidden="true" />Verifying your saved guest order…</div>}

        {!loading && !candidates.length && (
          <div className="mt-10 rounded-2xl bg-slate-50 p-6 text-sm text-slate-700">
            <strong>No guest order is saved on this device.</strong>
            <p className="mt-2">Sign in to view account orders, or contact Zyro.lk support if you need help with an older guest order.</p>
          </div>
        )}

        {!loading && error && (
          <div className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900" role="alert">
            <strong>{error}</strong>
            <p className="mt-2">Your saved recovery is kept on this device unless you choose to forget it.</p>
          </div>
        )}

        {!loading && order && (
          <div className="mt-10 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-5">
              <div><p className="text-sm text-slate-500">Order reference</p><strong className="text-2xl text-slate-900">{order.orderNumber}</strong><p className="mt-1 text-sm text-slate-500">Placed {formatDate(order.placedAt)}</p></div>
              <span className="rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold capitalize text-brand-blue">{order.status}</span>
            </div>
            <div className="space-y-3">
              {order.items.map((item, index) => <article key={`${item.name}-${index}`} className="flex items-center gap-4 rounded-2xl border border-slate-100 p-4"><img src={item.imageUrl || '/favicon.png'} alt="" className="h-16 w-16 rounded-xl object-cover" loading="lazy" /><div className="min-w-0 flex-1"><strong className="block truncate text-sm text-slate-900">{item.name}</strong><span className="text-sm text-slate-500">{item.quantity} × {formatPrice(item.unitPrice)}</span></div><b className="text-sm text-slate-900">{formatPrice(item.lineTotal)}</b></article>)}
            </div>
            <dl className="space-y-2 rounded-2xl bg-slate-50 p-5 text-sm"><div className="flex justify-between"><dt>Items subtotal</dt><dd>{formatPrice(order.itemsSubtotal)}</dd></div>{order.discount > 0 && <div className="flex justify-between text-emerald-700"><dt>Discount</dt><dd>−{formatPrice(order.discount)}</dd></div>}<div className="flex justify-between"><dt>Delivery</dt><dd>{order.deliveryFee === 0 ? 'Free' : formatPrice(order.deliveryFee)}</dd></div><div className="flex justify-between border-t border-slate-200 pt-3 text-base font-bold text-slate-900"><dt>Total</dt><dd>{formatPrice(order.totalPrice)}</dd></div></dl>
            {order.shipments.length > 0 && <section aria-labelledby="guest-order-shipments-title"><h2 id="guest-order-shipments-title" className="text-lg font-semibold text-slate-900">Shipment updates</h2><div className="mt-3 space-y-3">{order.shipments.map(shipment => <div key={`${shipment.courier}-${shipment.trackingNumber}`} className="rounded-2xl border border-slate-100 p-4 text-sm"><strong className="capitalize">{shipment.status}</strong><p className="mt-1 text-slate-600">{shipment.courier} · {shipment.trackingNumber}</p>{shipment.trackingUrl && <a className="mt-2 inline-block font-semibold text-brand-blue underline" href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer">View tracking</a>}</div>)}</div></section>}
          </div>
        )}

        <div className="mt-10 flex flex-wrap gap-3">
          {error && <button type="button" onClick={() => setRetryVersion(value => value + 1)} className="inline-flex items-center gap-2 rounded-xl bg-brand-blue px-4 py-3 text-sm font-semibold text-white"><RotateCcw aria-hidden="true" />Try again</button>}
          <button type="button" onClick={() => onNavigate('account-orders')} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700"><ShieldCheck aria-hidden="true" />Sign in / My Orders</button>
          {candidates.length > 0 && <button type="button" onClick={forgetOrder} className="inline-flex items-center gap-2 rounded-xl border border-rose-200 px-4 py-3 text-sm font-semibold text-rose-700"><Trash2 aria-hidden="true" />Forget this order</button>}
          <button type="button" onClick={() => onNavigate('contact')} className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Contact support</button>
        </div>
      </div>
    </section>
  );
}
