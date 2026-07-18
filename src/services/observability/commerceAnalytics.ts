import { app } from '../../firebase';

type CommerceEventName = 'add_to_cart' | 'begin_checkout' | 'add_payment_info' | 'purchase' | 'exception';
type AnalyticsParams = Record<string, string | number | boolean | undefined>;

let analyticsPromise: Promise<import('firebase/analytics').Analytics | null> | null = null;

async function analyticsInstance() {
  if (typeof window === 'undefined') return null;
  if (!analyticsPromise) {
    analyticsPromise = import('firebase/analytics').then(async ({ getAnalytics, isSupported }) => (
      await isSupported() ? getAnalytics(app) : null
    )).catch(() => null);
  }
  return analyticsPromise;
}

export async function initializeStorefrontMonitoring(): Promise<void> {
  if (typeof window === 'undefined') return;
  await Promise.allSettled([
    analyticsInstance(),
    import('firebase/performance').then(({ getPerformance }) => getPerformance(app)),
  ]);
}

export async function trackCommerceEvent(name: CommerceEventName, params: AnalyticsParams): Promise<void> {
  try {
    const analytics = await analyticsInstance();
    if (!analytics) return;
    const { logEvent } = await import('firebase/analytics');
    const logCommerceEvent = logEvent as unknown as (instance: typeof analytics, eventName: string, parameters: AnalyticsParams) => void;
    logCommerceEvent(analytics, name, params);
  } catch {
    // Analytics must never interrupt commerce.
  }
}

export function trackPurchaseOnce(orderId: string, value: number, paymentType: string, coupon?: string): void {
  try {
    const key = `zyro.analytics.purchase.${orderId}`;
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, '1');
    void trackCommerceEvent('purchase', {
      transaction_id: orderId,
      currency: 'LKR',
      value,
      payment_type: paymentType,
      ...(coupon ? { coupon } : {}),
    });
  } catch {
    void trackCommerceEvent('purchase', { transaction_id: orderId, currency: 'LKR', value, payment_type: paymentType });
  }
}
