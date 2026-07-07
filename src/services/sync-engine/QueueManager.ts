import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../../firebase';
import { ImportQueueEntry } from './types';

export class QueueManager {
  private static readonly COLLECTION_NAME = 'supplier_import_queue';

  /**
   * Spawns a new download and ingestion queue entry in the `supplier_import_queue` Firestore collection.
   */
  public static async createQueueEntry(
    supplierCode: string,
    supplierName: string,
    productName: string,
    source: 'Website' | 'WhatsApp',
    totalImages: number
  ): Promise<string> {
    const id = `imp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const nowIso = new Date().toISOString();

    const entry: ImportQueueEntry = {
      id,
      supplierCode,
      supplierName,
      productName,
      source,
      importStatus: 'Pending',
      progress: 0,
      totalImages,
      downloadedImages: 0,
      createdAt: nowIso
    };

    try {
      await setDoc(doc(db, this.COLLECTION_NAME, id), entry);
      return id;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.COLLECTION_NAME}/${id}`);
      throw error;
    }
  }

  /**
   * Updates progress of a pending ingestion run in the queue.
   */
  public static async updateProgress(
    id: string,
    downloadedImages: number,
    totalImages: number
  ): Promise<void> {
    const progress = totalImages > 0 ? Math.round((downloadedImages / totalImages) * 100) : 100;
    const updatePayload = {
      progress,
      downloadedImages,
      importStatus: 'Downloading' as const
    };

    try {
      await updateDoc(doc(db, this.COLLECTION_NAME, id), updatePayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.COLLECTION_NAME}/${id}`);
    }
  }

  /**
   * Marks a queue entry as successfully completed.
   */
  public static async markAsCompleted(id: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const updatePayload = {
      importStatus: 'Completed' as const,
      progress: 100,
      completedAt: nowIso
    };

    try {
      await updateDoc(doc(db, this.COLLECTION_NAME, id), updatePayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.COLLECTION_NAME}/${id}`);
    }
  }

  /**
   * Marks a queue entry as failed with an error message.
   */
  public static async markAsFailed(id: string, errorMessage: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const updatePayload = {
      importStatus: 'Failed' as const,
      completedAt: nowIso,
      errorMessage
    };

    try {
      await updateDoc(doc(db, this.COLLECTION_NAME, id), updatePayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.COLLECTION_NAME}/${id}`);
    }
  }
}
