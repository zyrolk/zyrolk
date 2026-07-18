export interface PayHerePaymentSession {
  provider: 'payhere';
  mode: 'sandbox' | 'live';
  actionUrl: string;
  fields: Record<string, string>;
}

export interface PaymentStatusView {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  paymentStatus: 'awaiting_payment' | 'pending' | 'paid' | 'cancelled' | 'failed' | 'chargedback' | 'expired' | string;
  paymentReference: string;
  paymentTimeline: Array<{ id?: string; status?: string; label?: string; source?: string; at?: string }>;
  totalPrice: number;
  createdAt: string;
}

export function submitPayHerePayment(session: PayHerePaymentSession): void {
  const action = new URL(session.actionUrl);
  if (action.protocol !== 'https:' || !['sandbox.payhere.lk', 'www.payhere.lk'].includes(action.hostname)) {
    throw new Error('The payment gateway address is invalid.');
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action.toString();
  form.hidden = true;
  Object.entries(session.fields).forEach(([name, value]) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = String(value);
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}

export function getPaymentReturnContext(search: string): { outcome: 'return' | 'cancel'; orderId: string; accessToken: string } | null {
  const params = new URLSearchParams(search);
  const outcome = params.get('payment');
  const orderId = params.get('order')?.trim() || '';
  const accessToken = params.get('access')?.trim() || '';
  if ((outcome !== 'return' && outcome !== 'cancel') || !orderId || !accessToken) return null;
  return { outcome, orderId, accessToken };
}

export function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_payment: 'Awaiting PayHere payment', pending: 'Payment processing', paid: 'Payment verified',
    cancelled: 'Payment cancelled', failed: 'Payment failed', chargedback: 'Payment chargeback', expired: 'Payment window expired',
  };
  return labels[status] || 'Payment status unavailable';
}
