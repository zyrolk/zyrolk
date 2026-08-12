import type { User } from 'firebase/auth';
import { fetchJson } from '../../services/network/fetchJson';
import type { SupplierPortalData, SupplierPortalProfile, SupplierProductDraft } from './types';

const request = async <T>(user: User, path: string, method = 'GET', body?: unknown): Promise<T> => {
  const token = await user.getIdToken();
  return fetchJson<T>(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, { fallbackMessage: 'Supplier Hub could not complete this request.' });
};

export const loadSupplierPortal = (
  user: User,
  cursors: Partial<Pick<SupplierPortalData['pagination'], 'productsCursor' | 'requestsCursor' | 'ordersCursor' | 'notificationsCursor'>> = {},
): Promise<SupplierPortalData> => {
  const query = new URLSearchParams({ pageSize: '100' });
  (Object.entries(cursors) as Array<[keyof typeof cursors, string | null | undefined]>).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  return request(user, `/api/supplier-portal?${query.toString()}`);
};

export const saveSupplierProfile = (user: User, profile: SupplierPortalProfile): Promise<{ success: true }> => request(
  user, '/api/supplier-portal/profile', 'PUT', profile,
);

export const saveSupplierProductDraft = (
  user: User,
  input: { requestId?: string; requestType: 'new_product' | 'product_change'; productId?: string; draft: SupplierProductDraft },
): Promise<{ success: true; requestId: string }> => request(user, '/api/supplier-portal/requests', 'POST', input);

export const submitSupplierProductRequest = (user: User, requestId: string): Promise<{ success: true; status: 'pending' }> => request(
  user, `/api/supplier-portal/requests/${encodeURIComponent(requestId)}/submit`, 'POST', {},
);

export const proposeSupplierStock = (user: User, productId: string, stock: number): Promise<{ success: true }> => request(
  user, `/api/supplier-portal/products/${encodeURIComponent(productId)}/stock-proposal`, 'POST', { stock },
);

export const updateSupplierFulfilment = (
  user: User,
  order: { id: string; groupId: string; groupRevision: number; orderPrivateRevision: number },
  status: string,
  reason?: string,
): Promise<{ success: true; status: string; groupRevision: number; orderPrivateRevision: number }> => request(
  user,
  `/api/supplier-portal/orders/${encodeURIComponent(order.id)}/groups/${encodeURIComponent(order.groupId)}/fulfilment`,
  'POST',
  {
    status,
    expectedGroupRevision: order.groupRevision,
    expectedOrderPrivateRevision: order.orderPrivateRevision,
    ...(reason ? { reason } : {}),
  },
);

export const recordSupplierTracking = (
  user: User,
  order: { id: string; groupId: string; groupRevision: number; orderPrivateRevision: number },
  courierName: string,
  trackingNumber: string,
): Promise<{ success: true; status: 'shipped'; groupRevision: number; orderPrivateRevision: number }> => request(
  user,
  `/api/supplier-portal/orders/${encodeURIComponent(order.id)}/groups/${encodeURIComponent(order.groupId)}/tracking`,
  'POST',
  {
    courierName,
    trackingNumber,
    expectedGroupRevision: order.groupRevision,
    expectedOrderPrivateRevision: order.orderPrivateRevision,
  },
);

export const markSupplierNotificationRead = (user: User, notificationId: string): Promise<{ success: true }> => request(
  user, `/api/supplier-portal/notifications/${encodeURIComponent(notificationId)}/read`, 'POST', {},
);
