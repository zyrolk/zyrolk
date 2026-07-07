import { SupplierReviewQueueItem } from '../../types';

export interface PreparedReviewPayload {
  reviewItem: SupplierReviewQueueItem;
  pendingChangesMirror: {
    id: string;
    supplierCode: string;
    productName: string;
    changeType: string;
    status: 'Pending';
    createdAt: string;
    payload: {
      oldValue: string;
      newValue: string;
    };
  };
}

export class ReviewPipeline {
  /**
   * Prepares the structured review payloads for submission.
   * Exposes structural representation only; does not write to the database or invoke any managers.
   */
  public static async prepareReviewPayload(
    item: Omit<SupplierReviewQueueItem, 'id' | 'createdAt' | 'status'>
  ): Promise<PreparedReviewPayload> {
    const id = `rev-payload-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const nowIso = new Date().toISOString();

    const reviewItem: SupplierReviewQueueItem = {
      ...item,
      id,
      status: 'Pending',
      createdAt: nowIso
    };

    const pendingChangesMirror = {
      id,
      supplierCode: item.supplierCode,
      productName: item.productName,
      changeType: item.changeType,
      status: 'Pending' as const,
      createdAt: nowIso,
      payload: {
        oldValue: item.oldValue,
        newValue: item.newValue
      }
    };

    return {
      reviewItem,
      pendingChangesMirror
    };
  }

  /**
   * Prepares update payloads for approving a review item.
   */
  public static async prepareApprovalPayload(
    id: string,
    reviewer: string
  ): Promise<{
    id: string;
    reviewQueueUpdate: {
      status: 'Approved';
      reviewedAt: string;
      reviewedBy: string;
    };
    pendingChangesUpdate: {
      status: 'Approved';
      reviewedAt: string;
      reviewedBy: string;
    };
  }> {
    const nowIso = new Date().toISOString();
    return {
      id,
      reviewQueueUpdate: {
        status: 'Approved',
        reviewedAt: nowIso,
        reviewedBy: reviewer
      },
      pendingChangesUpdate: {
        status: 'Approved',
        reviewedAt: nowIso,
        reviewedBy: reviewer
      }
    };
  }

  /**
   * Prepares update payloads for rejecting a review item.
   */
  public static async prepareRejectionPayload(
    id: string,
    reviewer: string
  ): Promise<{
    id: string;
    reviewQueueUpdate: {
      status: 'Rejected';
      reviewedAt: string;
      reviewedBy: string;
    };
    pendingChangesUpdate: {
      status: 'Rejected';
      reviewedAt: string;
      reviewedBy: string;
    };
  }> {
    const nowIso = new Date().toISOString();
    return {
      id,
      reviewQueueUpdate: {
        status: 'Rejected',
        reviewedAt: nowIso,
        reviewedBy: reviewer
      },
      pendingChangesUpdate: {
        status: 'Rejected',
        reviewedAt: nowIso,
        reviewedBy: reviewer
      }
    };
  }
}
