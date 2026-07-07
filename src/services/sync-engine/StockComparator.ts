import { StockComparisonResult } from './types';

export class StockComparator {
  /**
   * Compares the existing inventory levels with the newly imported supplier stock count.
   * Detects critical stock changes such as depletion, replenishment, and general quantity changes.
   * 
   * @param oldStock Current stock level in database
   * @param newStock New stock level reported by supplier
   */
  public static compare(oldStock: number, newStock: number): StockComparisonResult {
    const normalizedOld = Math.max(0, oldStock);
    const normalizedNew = Math.max(0, newStock);
    
    const hasChanged = normalizedOld !== normalizedNew;

    return {
      hasChanged,
      oldStock: normalizedOld,
      newStock: normalizedNew
    };
  }

  /**
   * Evaluates if this comparison triggers a critical stock state transition.
   */
  public static evaluateStateTransition(oldStock: number, newStock: number): {
    isReplenished: boolean;
    isDepleted: boolean;
    isCriticalLow: boolean;
    lowStockThreshold: number;
  } {
    const threshold = 3;
    const wasOutOfStock = oldStock <= 0;
    const isNowInStock = newStock > 0;
    const isNowOutOfStock = newStock <= 0;
    const wasAboveThreshold = oldStock > threshold;
    const isNowBelowThreshold = newStock <= threshold && newStock > 0;

    return {
      isReplenished: wasOutOfStock && isNowInStock,
      isDepleted: !wasOutOfStock && isNowOutOfStock,
      isCriticalLow: wasAboveThreshold && isNowBelowThreshold,
      lowStockThreshold: threshold
    };
  }
}
