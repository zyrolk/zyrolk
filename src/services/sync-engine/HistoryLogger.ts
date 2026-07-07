import { doc, setDoc } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../../firebase';
import { SyncHistoryEntry } from './types';

export class HistoryLogger {
  private static readonly HISTORY_COLLECTION = 'supplier_sync_history';
  private static readonly LOGS_COLLECTION = 'supplierSyncLogs';

  /**
   * Logs a comprehensive sync execution summary to both the detailed history table
   * and the light-weight visual log feed.
   */
  public static async logSyncRun(entry: Omit<SyncHistoryEntry, 'id' | 'timestamp'>): Promise<string> {
    const id = `hist-${Date.now()}`;
    const timestamp = new Date().toISOString();
    
    // 1. Build the full history entry
    const historyEntry: SyncHistoryEntry = {
      ...entry,
      id,
      timestamp
    };

    // 2. Build the lightweight log entry for dashboard activity feeds
    // Format timestamp as "MM/DD/YYYY, hh:mm AM/PM" to match the UI's design
    const formattedDate = new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const lightWeightLog = {
      id: `log-${Date.now()}`,
      supplierId: entry.supplierId,
      supplierName: entry.supplierName,
      timestamp: formattedDate,
      status: entry.status,
      error: entry.error || 'None',
      newProducts: entry.newProducts,
      priceChanges: entry.priceChanges,
      stockChanges: entry.stockChanges,
      imageChanges: entry.imageChanges,
      pendingReviews: entry.pendingReviews,
      triggeredBy: entry.triggeredBy
    };

    try {
      // Write to both Firestore paths
      await setDoc(doc(db, this.HISTORY_COLLECTION, id), historyEntry);
      await setDoc(doc(db, this.LOGS_COLLECTION, lightWeightLog.id), lightWeightLog);

      return id;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.HISTORY_COLLECTION}/${id}`);
      throw error;
    }
  }
}
