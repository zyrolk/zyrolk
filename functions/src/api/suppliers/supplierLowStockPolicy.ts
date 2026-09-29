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

export interface DropexLowStockReviewHoldInput {
  source: unknown;
  productLive: boolean;
  stockKnown: boolean;
  stock: unknown;
}

export const isLowStockHoldSource = (source: unknown): boolean => (
  String(source || "").trim().toLowerCase() === LOW_STOCK_HOLD_SOURCE_ID
);

/**
 * A canonical product is live only while it exists and neither visibility flag
 * withdraws it. A missing, inactive or invisible product is not live.
 */
export const isSupplierProductLive = (product: Record<string, unknown> | null | undefined): boolean => (
  Boolean(product)
  && product!.isActive !== false
  && product!.visible !== false
);

/**
 * Low Stock Hold applies to any Dropex observation whose canonical product is
 * not live, independent of the comparison status. Live products may fall to
 * 0-3 units through the inventory automation without entering the hold.
 * Unknown and malformed inventory remain governed by the existing validation
 * paths and are deliberately not classified as low stock.
 */
export const isDropexLowStockReviewHold = (input: DropexLowStockReviewHoldInput): boolean => (
  isLowStockHoldSource(input.source)
  && input.productLive !== true
  && input.stockKnown === true
  && Number.isInteger(input.stock)
  && Number(input.stock) >= 0
  && Number(input.stock) < MIN_SUPPLIER_STOCK_FOR_NEW_PUBLICATION
);

/** Legacy entry point retained for callers that only know "new and unpublished". */
export const isLowStockHoldForNewSupplierProduct = (
  input: NewSupplierProductStockPolicyInput,
): boolean => isDropexLowStockReviewHold({
  source: input.supplierSourceId,
  productLive: !input.isNewUnpublished,
  stockKnown: input.stockKnown,
  stock: input.stock,
});

/**
 * Publishing a not-live Dropex product requires trusted, known, integer stock
 * of at least four units. Unknown or malformed stock fails closed.
 */
export const supplierStockAllowsPublication = (input: { stock: unknown; stockKnown: boolean }): boolean => (
  input.stockKnown === true
  && Number.isInteger(input.stock)
  && Number(input.stock) >= MIN_SUPPLIER_STOCK_FOR_NEW_PUBLICATION
);

export const lowSupplierStockValidationError = () => ({
  field: "stock",
  code: LOW_SUPPLIER_STOCK_FOR_PUBLICATION_CODE,
  message: LOW_SUPPLIER_STOCK_FOR_PUBLICATION_MESSAGE,
});
