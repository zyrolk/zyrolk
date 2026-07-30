import { app } from '../../firebase';

type CommerceEventName =
  | 'view_item'
  | 'view_cart'
  | 'search'
  | 'add_to_wishlist'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'begin_checkout'
  | 'add_payment_info'
  | 'purchase'
  | 'exception';
type AnalyticsParams = Record<string, unknown>;

export interface CommerceAnalyticsItem {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
}

export const commerceAnalyticsItem = (input: {
  id: string;
  name: string;
  price: number;
  quantity?: number;
}): CommerceAnalyticsItem => ({
  item_id: input.id,
  item_name: input.name.slice(0, 200),
  price: Number.isFinite(input.price) ? Math.max(0, input.price) : 0,
  quantity: Number.isInteger(input.quantity) && Number(input.quantity) > 0 ? Number(input.quantity) : 1,
});

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

export function trackPurchaseOnce(
  orderId: string,
  value: number,
  paymentType: string,
  coupon?: string,
  items?: CommerceAnalyticsItem[],
): void {
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
      ...(items?.length ? { items } : {}),
    });
  } catch {
    void trackCommerceEvent('purchase', {
      transaction_id: orderId,
      currency: 'LKR',
      value,
      payment_type: paymentType,
      ...(items?.length ? { items } : {}),
    });
  }
}
