import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../../firebase';
import { SupplierReviewQueueItem } from '../../types';

export class ReviewManager {
  private static readonly REVIEW_QUEUE_COLLECTION = 'supplier_review_queue';
  private static readonly PENDING_CHANGES_COLLECTION = 'supplier_pending_changes';

  /**
   * Submits a newly detected product fluctuation or new item into the manual review queue.
   */
  public static async submitToReviewQueue(
    item: Omit<SupplierReviewQueueItem, 'id' | 'createdAt' | 'status'>
  ): Promise<string> {
    const id = `rev-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const nowIso = new Date().toISOString();

    const reviewItem: SupplierReviewQueueItem = {
      ...item,
      id,
      status: 'Pending',
      createdAt: nowIso
    };

    try {
      await setDoc(doc(db, this.REVIEW_QUEUE_COLLECTION, id), reviewItem);
      
      // Also mirror to supplier_pending_changes for granular change processing
      await setDoc(doc(db, this.PENDING_CHANGES_COLLECTION, id), {
        id,
        supplierCode: item.supplierCode,
        productName: item.productName,
        changeType: item.changeType,
        status: 'Pending',
        createdAt: nowIso,
        payload: {
          oldValue: item.oldValue,
          newValue: item.newValue
        }
      });

      return id;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.REVIEW_QUEUE_COLLECTION}/${id}`);
      throw error;
    }
  }

  /**
   * Evaluates and updates a queue item state to Approved.
   */
  public static async approveReviewItem(id: string, reviewedBy: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const updatePayload = {
      status: 'Approved' as const,
      reviewedAt: nowIso,
      reviewedBy
    };

    try {
      await updateDoc(doc(db, this.REVIEW_QUEUE_COLLECTION, id), updatePayload);
      await updateDoc(doc(db, this.PENDING_CHANGES_COLLECTION, id), {
        status: 'Approved',
        reviewedAt: nowIso,
        reviewedBy
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.REVIEW_QUEUE_COLLECTION}/${id}`);
    }
  }

  /**
   * Evaluates and updates a queue item state to Rejected.
   */
  public static async rejectReviewItem(id: string, reviewedBy: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const updatePayload = {
      status: 'Rejected' as const,
      reviewedAt: nowIso,
      reviewedBy
    };

    try {
      await updateDoc(doc(db, this.REVIEW_QUEUE_COLLECTION, id), updatePayload);
      await updateDoc(doc(db, this.PENDING_CHANGES_COLLECTION, id), {
        status: 'Rejected',
        reviewedAt: nowIso,
        reviewedBy
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.REVIEW_QUEUE_COLLECTION}/${id}`);
    }
  }
}
