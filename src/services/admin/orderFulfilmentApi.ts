import type { User } from 'firebase/auth';
import { fetchJson } from '../network/fetchJson';

export type AdminFulfilmentGroupStatus = 'unassigned' | 'assigned' | 'accepted' | 'processing' | 'packed' | 'shipped' | 'delivered';

export interface FulfilmentTrackingView {
  courierName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  recordedAt: string;
  recordedBy: string;
  revision: number;
}

export interface AdminFulfilmentGroup {
  groupId: string;
  lineIds: string[];
  supplierAccountId: string;
  supplierSourceIds: string[];
  supplierName: string;
  status: AdminFulfilmentGroupStatus;
  revision: number;
  assignedAt: string | null;
  acceptedAt: string | null;
  processingAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  tracking: FulfilmentTrackingView | null;
  declineReason: string | null;
}

export interface AdminOrderFulfilmentView {
  success: true;
  orderId: string;
  attributionAvailable: boolean;
  message?: string;
  orderPrivateRevision: number | null;
  groups: AdminFulfilmentGroup[];
}

const request = async <T>(user: User, path: string, method = 'GET', body?: unknown): Promise<T> => {
  const token = await user.getIdToken();
  return fetchJson<T>(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, { fallbackMessage: 'Order fulfilment could not be updated.' });
};

export const loadAdminOrderFulfilment = (user: User, orderId: string): Promise<AdminOrderFulfilmentView> => request(
  user,
  `/api/supplier-portal/orders/${encodeURIComponent(orderId)}/fulfilment-groups`,
);

export const assignAdminOrderFulfilmentGroup = (
  user: User,
  orderId: string,
  group: AdminFulfilmentGroup,
  orderPrivateRevision: number,
): Promise<{ success: true; status: AdminFulfilmentGroupStatus; groupRevision: number; orderPrivateRevision: number }> => request(
  user,
  `/api/supplier-portal/orders/${encodeURIComponent(orderId)}/assign`,
  'POST',
  {
    groupId: group.groupId,
    supplierId: group.supplierAccountId,
    expectedGroupRevision: group.revision,
    expectedOrderPrivateRevision: orderPrivateRevision,
  },
);

export const correctAdminOrderFulfilmentTracking = (
  user: User,
  orderId: string,
  group: AdminFulfilmentGroup,
  orderPrivateRevision: number,
  courierName: string,
  trackingNumber: string,
): Promise<{ success: true; status: AdminFulfilmentGroupStatus; groupRevision: number; orderPrivateRevision: number }> => request(
  user,
  `/api/supplier-portal/orders/${encodeURIComponent(orderId)}/groups/${encodeURIComponent(group.groupId)}/tracking/correct`,
  'POST',
  {
    courierName,
    trackingNumber,
    expectedGroupRevision: group.revision,
    expectedOrderPrivateRevision: orderPrivateRevision,
  },
);
