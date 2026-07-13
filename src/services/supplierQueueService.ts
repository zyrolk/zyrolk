import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { auth, db } from '../firebase';
import {
  buildSupplierQueueDecisionPlan,
  SupplierQueueAction,
  SupplierQueueDecisionItem,
  getSupplierReviewQueueItemId,
} from './supplierQueueDecisionPlan';
import { normalizeSupplierProductImages } from './connectors/a2z-website/productImages';

export type { SupplierQueueDecisionItem };
export { getSupplierReviewQueueItemId };

export const approveSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  const productPayload = item.productPayload;

  if (!productPayload?.id) {
    throw new Error(`Product payload not found for queue item: ${item.id}`);
  }

  const normalizedImages = normalizeSupplierProductImages(productPayload.imageUrl, productPayload.imageUrls);
  if (normalizedImages.length === 0) {
    throw new Error('A valid supplier product image is required before publishing. Sync the real supplier image and review the item again.');
  }

  await writeSupplierQueueDecision({
    ...item,
    productPayload: {
      ...productPayload,
      imageUrl: normalizedImages[0],
      imageUrls: normalizedImages,
    },
  }, 'approved');
};

export const rejectSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await writeSupplierQueueDecision(item, 'rejected');
};

const writeSupplierQueueDecision = async (
  item: SupplierQueueDecisionItem,
  action: SupplierQueueAction,
): Promise<void> => {
  const reviewQueueItemId = getSupplierReviewQueueItemId(item);
  const currentUser = auth.currentUser;
  const batch = writeBatch(db);
  const auditId = `${reviewQueueItemId}-${action}-${Date.now()}`;
  const plan = buildSupplierQueueDecisionPlan(
    item,
    action,
    {
      uid: currentUser?.uid || 'unknown',
      email: currentUser?.email || 'unknown',
    },
    serverTimestamp(),
    auditId,
  );

  for (const operation of plan.sets) {
    if (operation.options) {
      batch.set(doc(db, operation.collection, operation.id), operation.data, operation.options);
    } else {
      batch.set(doc(db, operation.collection, operation.id), operation.data);
    }
  }

  for (const operation of plan.deletes) {
    batch.delete(doc(db, operation.collection, operation.id));
  }

  await batch.commit();
};
