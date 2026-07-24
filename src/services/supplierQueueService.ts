import { auth } from '../firebase';
import { getAppCheckRequestHeaders } from './security/appCheck';
import {
  getSupplierReviewQueueItemId,
  SupplierQueueDecisionItem,
} from './supplierQueueDecisionPlan';

export type { SupplierQueueDecisionItem };
export { getSupplierReviewQueueItemId };

export type SupplierQueueDecisionAction = 'approve' | 'reject' | 'delete';

/**
 * Compatibility wrapper for legacy admin surfaces. Queue decisions are deliberately
 * executed only by the authenticated Firebase Functions API; this module never
 * performs browser Firestore writes.
 */
export const requestSupplierQueueDecision = async (
  queueItemId: string,
  action: SupplierQueueDecisionAction,
  body: Record<string, unknown> = {},
): Promise<void> => {
  const [token, appCheckHeaders] = await Promise.all([
    auth.currentUser?.getIdToken(),
    getAppCheckRequestHeaders(),
  ]);
  if (!token) throw new Error('Admin authentication is required. Please sign in again.');
  const response = await fetch(`/api/supplier-review-queue/${encodeURIComponent(queueItemId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...appCheckHeaders },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
  if (!response.ok || result.success !== true) {
    throw new Error(result.error || 'Supplier review action could not be completed.');
  }
};

/** @deprecated Use requestSupplierQueueDecision with an explicit review draft. */
export const approveSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await requestSupplierQueueDecision(item.id, 'approve');
};

/** @deprecated Use requestSupplierQueueDecision. */
export const rejectSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await requestSupplierQueueDecision(item.id, 'reject', { rejectionReason: item.rejectionReason || 'Rejected by admin.' });
};

/** @deprecated Use requestSupplierQueueDecision. */
export const deleteSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await requestSupplierQueueDecision(item.id, 'delete', { deletionReason: item.deletionReason || 'Deleted by admin.' });
};
