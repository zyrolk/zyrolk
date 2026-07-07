import { PriceComparisonResult } from './types';

export class PriceComparator {
  /**
   * Compares the previous cost price and the newly ingested cost price.
   * Calculates the projected customer-facing pricing based on markup and profit margin.
   * 
   * @param oldCostPrice The current cost price stored in the database (or 0 if new)
   * @param newCostPrice The new cost price from the supplier
   * @param oldPrice The current retail selling price (or 0 if new)
   * @param oldOriginalPrice The current retail original/regular price (or undefined)
   * @param markupPercent The config-driven markup percentage (e.g., 10%)
   * @param marginPercent The config-driven profit margin percentage (e.g., 15%)
   */
  public static compare(
    oldCostPrice: number,
    newCostPrice: number,
    oldPrice: number,
    oldOriginalPrice: number | undefined,
    markupPercent: number,
    marginPercent: number
  ): PriceComparisonResult {
    // 1. Calculate projected selling price:
    // Formula: Selling Price = Cost Price * (1 + (Markup + Margin) / 100)
    const combinedPercentage = (markupPercent || 0) + (marginPercent || 0);
    const newPrice = Math.round(newCostPrice * (1 + combinedPercentage / 100));

    // 2. Calculate an optional original list price (to show automated strike-through discounts on the frontend)
    // E.g. Original Price is 10% higher than the selling price to create an attractive retail comparison
    const newOriginalPrice = Math.round(newPrice * 1.12);

    const hasChanged = Math.abs(oldCostPrice - newCostPrice) > 0.01 || Math.abs(oldPrice - newPrice) > 0.01;

    return {
      hasChanged,
      oldCostPrice,
      newCostPrice,
      oldPrice,
      newPrice,
      oldOriginalPrice,
      newOriginalPrice,
      markupPercent,
      marginPercent
    };
  }
}
