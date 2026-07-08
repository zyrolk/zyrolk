import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Product } from '../types';

export interface SupplierQueueDecisionItem {
  id: string;
  productName?: string;
  productPayload?: Product & Record<string, unknown>;
  reviewQueueItemId?: string;
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

  await setDoc(doc(db, 'products', productPayload.id), productPayload, { merge: true });
  await removeSupplierQueueItem(item);
};

export const rejectSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await removeSupplierQueueItem(item);
};

const removeSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  const reviewQueueItemId = getSupplierReviewQueueItemId(item);

  await Promise.all([
    deleteDoc(doc(db, 'supplier_review_queue', reviewQueueItemId)),
    deleteDoc(doc(db, 'supplier_pending_changes', `change-${reviewQueueItemId}`)),
    deleteDoc(doc(db, 'supplier_import_queue', reviewQueueItemId)),
  ]);
};
