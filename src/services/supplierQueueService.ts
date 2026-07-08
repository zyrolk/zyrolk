import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Product } from '../types';

export interface SupplierQueueDecisionItem {
  id: string;
  productName?: string;
  productPayload?: Product & Record<string, unknown>;
  reviewQueueItemId?: string;
  sourceId?: string;
  batchId?: string;
  rejectionReason?: string;
}

export const getSupplierReviewQueueItemId = (item: SupplierQueueDecisionItem): string => {
  if (item.reviewQueueItemId) {
    return item.reviewQueueItemId;
  }

  if (item.id.startsWith('change-')) {
    return item.id.slice('change-'.length);
  }

  return item.id;
};

export const approveSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  const productPayload = item.productPayload;

  if (!productPayload?.id) {
    throw new Error(`Product payload not found for queue item: ${item.id}`);
  }

  await writeSupplierQueueDecision(item, 'approved', productPayload.id);
};

export const rejectSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await writeSupplierQueueDecision(item, 'rejected');
};

const writeSupplierQueueDecision = async (
  item: SupplierQueueDecisionItem,
  action: 'approved' | 'rejected',
  productId?: string
): Promise<void> => {
  const reviewQueueItemId = getSupplierReviewQueueItemId(item);
  const queueDocumentId = item.id;
  const currentUser = auth.currentUser;
  const batch = writeBatch(db);
  const auditId = `${reviewQueueItemId}-${action}-${Date.now()}`;
  const auditPayload: Record<string, unknown> = {
    id: auditId,
    action,
    reviewedBy: {
      uid: currentUser?.uid || 'unknown',
      email: currentUser?.email || 'unknown',
    },
    reviewedAt: serverTimestamp(),
    sourceId: item.sourceId || 'unknown',
    batchId: item.batchId || 'unknown',
    queueDocumentId,
  };

  if (action === 'approved') {
    if (!productId || !item.productPayload) {
      throw new Error(`Product payload not found for queue item: ${item.id}`);
    }

    auditPayload.productId = productId;
    batch.set(doc(db, 'products', productId), item.productPayload, { merge: true });
  }

  if (action === 'rejected' && item.rejectionReason) {
    auditPayload.rejectionReason = item.rejectionReason;
  }

  batch.set(doc(db, 'supplier_approval_audit', auditId), auditPayload);
  batch.delete(doc(db, 'supplier_review_queue', reviewQueueItemId));
  batch.delete(doc(db, 'supplier_pending_changes', `change-${reviewQueueItemId}`));
  batch.delete(doc(db, 'supplier_import_queue', reviewQueueItemId));

  await batch.commit();
};
