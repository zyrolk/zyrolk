export const MIN_SUPPLIER_STOCK_FOR_NEW_PUBLICATION = 4;

export const LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE = "LOW_SUPPLIER_STOCK_FOR_PUBLICATION";

export const LOW_SUPPLIER_STOCK_FOR_PUBLICATION_MESSAGE =
  "Supplier stock must be at least 4 units before publication.";

export const LOW_STOCK_HOLD_SOURCE_ID = "dropex";

export interface NewSupplierProductStockPolicyInput {
  isNewUnpublished: boolean;
  supplierSourceId: unknown;
  stock: unknown;
  stockKnown: boolean;
}

/**
 * Low Stock Hold applies only to a new, unpublished supplier-backed product.
 * Unknown and malformed inventory remain governed by the existing validation
 * paths and are deliberately not classified as low stock.
 */
export const isLowStockHoldForNewSupplierProduct = (
  input: NewSupplierProductStockPolicyInput,
): boolean => (
  input.isNewUnpublished
  && String(input.supplierSourceId || "").trim().toLowerCase() === LOW_STOCK_HOLD_SOURCE_ID
  && input.stockKnown
  && Number.isInteger(input.stock)
  && Number(input.stock) >= 0
  && Number(input.stock) < MIN_SUPPLIER_STOCK_FOR_NEW_PUBLICATION
);

export const lowSupplierStockValidationError = () => ({
  field: "stock",
  code: LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE,
  message: LOW_SUPPLIER_STOCK_FOR_PUBLICATION_MESSAGE,
});
