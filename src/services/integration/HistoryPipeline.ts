import { SyncHistoryEntry } from '../sync-engine/types';

export interface PreparedHistoryPayload {
  historyEntry: SyncHistoryEntry;
  lightWeightLog: {
    id: string;
    supplierId: string;
    supplierName: string;
    timestamp: string;
    status: 'success' | 'failed';
    error: string;
    newProducts: number;
    priceChanges: number;
    stockChanges: number;
    imageChanges: number;
    pendingReviews: number;
    triggeredBy: string;
  };
}

export class HistoryPipeline {
  /**
   * Prepares execution summaries for sync logging and visual logs.
   * Exposes structural representation only; does not write to the database or invoke any loggers.
   */
  public static async prepareHistoryPayload(
    entry: Omit<SyncHistoryEntry, 'id' | 'timestamp'>
  ): Promise<PreparedHistoryPayload> {
    const id = `hist-payload-${Date.now()}`;
    const timestamp = new Date().toISOString();

    const historyEntry: SyncHistoryEntry = {
      ...entry,
      id,
      timestamp
    };

    const formattedDate = new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const lightWeightLog = {
      id: `log-payload-${Date.now()}`,
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

    return {
      historyEntry,
      lightWeightLog
    };
  }
}
