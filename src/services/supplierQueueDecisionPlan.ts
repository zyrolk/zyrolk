import { Product } from '../types';
import { PRODUCT_PRIVATE_COLLECTION, splitProductData } from './products/productCommercialData';

export interface SupplierQueueDecisionItem {
  id: string;
  productName?: string;
  productPayload?: Product & Record<string, unknown>;
  reviewQueueItemId?: string;
  sourceId?: string;
  batchId?: string;
  rejectionReason?: string;
  deletionReason?: string;
  supplierSnapshot?: Record<string, unknown>;
  portalRequestId?: string;
  supplierId?: string;
  supplierSkuClaimId?: string;
  productFingerprintClaimId?: string;
}

export interface SupplierQueueReviewer {
  uid: string;
  email: string;
}

export type SupplierQueueAction = 'approved' | 'rejected' | 'deleted';

export interface SupplierQueueSetOperation {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  options?: { merge: boolean };
  removeCommercialProductFields?: boolean;
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
    if (item.supplierSnapshot) {
      auditPayload.supplierSnapshot = item.supplierSnapshot;
    }
    auditPayload.publishedProductSnapshot = item.productPayload;
    const { publicData, commercialData } = splitProductData(item.productPayload);
    sets.push({
      collection: 'products',
      id: productId,
      data: publicData,
      options: { merge: true },
      removeCommercialProductFields: true,
    });
    if (Object.keys(commercialData).length > 0) {
      sets.push({
        collection: PRODUCT_PRIVATE_COLLECTION,
        id: productId,
        data: {
          ...commercialData,
          productId,
          updatedAt: item.productPayload.updatedAt || reviewedAt,
        },
        options: { merge: true },
      });
    }
  }

  if (action === 'rejected' && item.rejectionReason) {
    auditPayload.rejectionReason = item.rejectionReason;
  }

  if (action === 'deleted' && item.deletionReason) {
    auditPayload.deletionReason = item.deletionReason;
  }

  if (item.portalRequestId && item.supplierId) {
    const requestStatus = action === 'approved' ? 'approved' : 'rejected';
    const reason = action === 'rejected'
      ? item.rejectionReason || 'Product request rejected by admin.'
      : action === 'deleted'
        ? item.deletionReason || 'Product request removed by admin.'
        : '';
    sets.push({
      collection: 'supplier_product_requests',
      id: item.portalRequestId,
      data: {
        status: requestStatus,
        reviewedAt,
        reviewedBy: reviewer,
        ...(reason ? { rejectionReason: reason } : {}),
      },
      options: { merge: true },
    });
    sets.push({
      collection: 'supplier_notifications',
      id: `${item.portalRequestId}-${action}`,
      data: {
        supplierId: item.supplierId,
        type: action === 'approved' ? 'product_approved' : 'product_rejected',
        title: action === 'approved' ? 'Product approved' : 'Product rejected',
        message: action === 'approved'
          ? `${item.productName || 'Your product'} was approved.`
          : reason,
        productRequestId: item.portalRequestId,
        isRead: false,
        createdAt: reviewedAt,
      },
    });
    if (action !== 'approved') {
      if (item.supplierSkuClaimId) deletes.push({ collection: 'supplier_sku_claims', id: item.supplierSkuClaimId });
      if (item.productFingerprintClaimId) deletes.push({ collection: 'supplier_product_claims', id: item.productFingerprintClaimId });
    }
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
