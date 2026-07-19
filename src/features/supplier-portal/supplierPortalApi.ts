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

export const loadSupplierPortal = (user: User): Promise<SupplierPortalData> => request(user, '/api/supplier-portal');

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

export const updateSupplierFulfilment = (user: User, orderId: string, status: string): Promise<{ success: true; status: string }> => request(
  user, `/api/supplier-portal/orders/${encodeURIComponent(orderId)}/fulfilment`, 'POST', { status },
);

export const markSupplierNotificationRead = (user: User, notificationId: string): Promise<{ success: true }> => request(
  user, `/api/supplier-portal/notifications/${encodeURIComponent(notificationId)}/read`, 'POST', {},
);
