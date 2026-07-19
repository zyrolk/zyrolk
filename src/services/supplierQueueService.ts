import { deleteField, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { auth, db } from '../firebase';
import {
  buildSupplierQueueDecisionPlan,
  SupplierQueueAction,
  SupplierQueueDecisionItem,
  getSupplierReviewQueueItemId,
} from './supplierQueueDecisionPlan';
import { normalizeSupplierProductImages } from './connectors/a2z-website/productImages';
import { validateSupplierPublishPayload } from './supplierReviewEditor';
import { buildCommercialFieldDeletes } from './products/productCommercialData';

export type { SupplierQueueDecisionItem };
export { getSupplierReviewQueueItemId };

export const approveSupplierQueueItem = async (
  item: SupplierQueueDecisionItem,
  validCategoryIds?: readonly string[],
): Promise<void> => {
  const productPayload = item.productPayload;

  if (!productPayload?.id) {
    throw new Error(`Product payload not found for queue item: ${item.id}`);
  }

  const validationErrors = validateSupplierPublishPayload(item, validCategoryIds);
  const firstError = Object.values(validationErrors)[0];
  if (firstError) {
    throw new Error(firstError);
  }

  const normalizedImages = normalizeSupplierProductImages(productPayload.imageUrl, productPayload.imageUrls);

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

export const deleteSupplierQueueItem = async (item: SupplierQueueDecisionItem): Promise<void> => {
  await writeSupplierQueueDecision(item, 'deleted');
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
    const operationData = operation.removeCommercialProductFields
      ? { ...operation.data, ...buildCommercialFieldDeletes(deleteField()) }
      : operation.data;
    if (operation.options) {
      batch.set(doc(db, operation.collection, operation.id), operationData, operation.options);
    } else {
      batch.set(doc(db, operation.collection, operation.id), operationData);
    }
  }

  for (const operation of plan.deletes) {
    batch.delete(doc(db, operation.collection, operation.id));
  }

  await batch.commit();
};
