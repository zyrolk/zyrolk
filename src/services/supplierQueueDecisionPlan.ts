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

export interface SupplierQueueReviewer {
  uid: string;
  email: string;
}

export type SupplierQueueAction = 'approved' | 'rejected';

export interface SupplierQueueSetOperation {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  options?: { merge: boolean };
}

export interface SupplierQueueDeleteOperation {
  collection: string;
  id: string;
}

export interface SupplierQueueDecisionPlan {
  auditId: string;
  sets: SupplierQueueSetOperation[];
  deletes: SupplierQueueDeleteOperation[];
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

export function buildSupplierQueueDecisionPlan(
  item: SupplierQueueDecisionItem,
  action: SupplierQueueAction,
  reviewer: SupplierQueueReviewer,
  reviewedAt: unknown,
  auditId: string,
): SupplierQueueDecisionPlan {
  const reviewQueueItemId = getSupplierReviewQueueItemId(item);
  const queueDocumentId = item.id;
  const sets: SupplierQueueSetOperation[] = [];
  const deletes: SupplierQueueDeleteOperation[] = [
    { collection: 'supplier_review_queue', id: reviewQueueItemId },
    { collection: 'supplier_pending_changes', id: `change-${reviewQueueItemId}` },
    { collection: 'supplier_import_queue', id: reviewQueueItemId },
  ];
  const auditPayload: Record<string, unknown> = {
    id: auditId,
    action,
    reviewedBy: reviewer,
    reviewedAt,
    sourceId: item.sourceId || 'unknown',
    batchId: item.batchId || 'unknown',
    queueDocumentId,
  };

  if (action === 'approved') {
    const productId = item.productPayload?.id;
    if (!productId) {
      throw new Error(`Product payload not found for queue item: ${item.id}`);
    }

    auditPayload.productId = productId;
    sets.push({
      collection: 'products',
      id: productId,
      data: item.productPayload,
      options: { merge: true },
    });
  }

  if (action === 'rejected' && item.rejectionReason) {
    auditPayload.rejectionReason = item.rejectionReason;
  }

  sets.push({
    collection: 'supplier_approval_audit',
    id: auditId,
    data: auditPayload,
  });

  return {
    auditId,
    sets,
    deletes,
  };
}
