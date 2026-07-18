import { User } from 'firebase/auth';
import { CheckCircle2, Clock3, CreditCard, LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../services/network/fetchJson';
import { reportClientIssue } from '../../services/observability/clientDiagnostics';
import { trackPurchaseOnce } from '../../services/observability/commerceAnalytics';
import { PayHerePaymentSession, PaymentStatusView, paymentStatusLabel, submitPayHerePayment } from './payhere';
import './paymentReturn.css';

interface PaymentReturnPageProps {
  user: User | null;
  outcome: 'return' | 'cancel';
  orderId: string;
  accessToken: string;
  onPaymentConfirmed: () => void;
  onContinue: () => void;
  onOrders: () => void;
}

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(amount);

export default function PaymentReturnPage({
  user, outcome, orderId, accessToken, onPaymentConfirmed, onContinue, onOrders,
}: PaymentReturnPageProps) {
  const [order, setOrder] = useState<PaymentStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const pollCount = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const token = user ? await user.getIdToken() : '';
      const result = await fetchJson<{ success: true; order: PaymentStatusView }>('/api/payments/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ orderId, accessToken }),
      }, { fallbackMessage: 'Payment status could not be verified right now.' });
      setOrder(result.order);
      setError('');
      if (result.order.paymentStatus === 'paid') {
        onPaymentConfirmed();
        trackPurchaseOnce(result.order.id, result.order.totalPrice, 'payhere');
      }
      return result.order.paymentStatus;
    } catch (statusError) {
      reportClientIssue('payhere-return-status', statusError, 'warning');
      setError(statusError instanceof Error ? statusError.message : 'Payment status could not be verified right now.');
      return 'error';
    } finally {
      setLoading(false);
    }
  }, [accessToken, onPaymentConfirmed, orderId, user]);

  useEffect(() => {
    headingRef.current?.focus();
    let timer: number | undefined;
    let cancelled = false;
    const poll = async () => {
      const status = await loadStatus();
      if (cancelled || !['awaiting_payment', 'pending', 'error'].includes(status) || pollCount.current >= 7) return;
      pollCount.current += 1;
      timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [loadStatus]);

  const retryPayment = async () => {
    if (retrying) return;
    setRetrying(true); setError('');
    try {
      const token = user ? await user.getIdToken() : '';
      const result = await fetchJson<{ success: true; paymentSession: PayHerePaymentSession }>(
        `/api/payments/${encodeURIComponent(orderId)}/retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ accessToken }),
        },
        { fallbackMessage: 'Payment could not be retried.' },
      );
      submitPayHerePayment(result.paymentSession);
    } catch (retryError) {
      reportClientIssue('payhere-payment-retry', retryError, 'warning');
      setError(retryError instanceof Error ? retryError.message : 'Payment could not be retried.');
      setRetrying(false);
    }
  };

  const status = order?.paymentStatus || (outcome === 'cancel' ? 'cancelled' : 'pending');
  const isPaid = status === 'paid';
  const canRetry = ['cancelled', 'failed', 'expired'].includes(status);
  const StatusIcon = isPaid ? CheckCircle2 : canRetry ? ShieldAlert : Clock3;

  return <main className="zy-payment-return" aria-labelledby="payment-return-title">
    <section className={`zy-payment-return-card is-${status}`} aria-busy={loading}>
      <span className="sr-only" role="status" aria-live="polite">{loading ? 'Verifying payment' : paymentStatusLabel(status)}</span>
      <span className="zy-payment-return-icon" aria-hidden="true">{loading ? <LoaderCircle className="is-spinning" /> : <StatusIcon />}</span>
      <p className="zy-section-eyebrow">Secure PayHere checkout</p>
      <h1 id="payment-return-title" ref={headingRef} tabIndex={-1}>{loading ? 'Verifying your payment' : paymentStatusLabel(status)}</h1>
      <p>{loading
        ? 'Please wait while Zyro.lk checks the trusted server notification. Do not refresh this page.'
        : isPaid
          ? 'PayHere verified your payment server-side. Your order is confirmed and ready for fulfilment.'
          : canRetry
            ? 'No successful payment was recorded. Reserved stock was safely released and you can retry while stock remains available.'
            : 'PayHere has not completed server verification yet. This page checks again automatically.'}</p>

      {order && <div className="zy-payment-return-summary">
        <div><small>Order</small><strong>{order.orderNumber || order.id.slice(0, 8).toUpperCase()}</strong></div>
        <div><small>Total</small><strong>{formatPrice(order.totalPrice)}</strong></div>
        {order.paymentReference && <div><small>Transaction</small><strong>{order.paymentReference}</strong></div>}
      </div>}

      {order?.paymentTimeline?.length ? <ol className="zy-payment-timeline" aria-label="Payment status timeline">
        {order.paymentTimeline.map((event, index) => <li key={event.id || `${event.status}-${index}`}><span><ShieldCheck /></span><div><strong>{event.label || paymentStatusLabel(event.status || '')}</strong><small>{event.at ? new Intl.DateTimeFormat('en-LK', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.at)) : 'Recorded securely'}</small></div></li>)}
      </ol> : null}

      {error && <div className="zy-payment-return-error" role="alert">{error}</div>}
      <div className="zy-payment-return-actions">
        {canRetry && <button type="button" onClick={retryPayment} disabled={retrying}>{retrying ? <LoaderCircle className="is-spinning" /> : <CreditCard />}{retrying ? 'Preparing secure payment' : 'Retry with PayHere'}</button>}
        {!loading && !isPaid && !canRetry && <button type="button" onClick={() => void loadStatus()}><RefreshCw />Check again</button>}
        {user && <button type="button" onClick={onOrders}>View My Orders</button>}
        <button type="button" onClick={onContinue}>Continue shopping</button>
      </div>
    </section>
  </main>;
}
