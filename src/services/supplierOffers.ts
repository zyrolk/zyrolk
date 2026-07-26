export interface SupplierOfferView {
  id: string;
  productId: string | null;
  supplierId: string;
  sourceId: string;
  supplierProductId: string;
  sku: string;
  barcode: string;
  price: number;
  cost: number;
  stock: number;
  availability: 'in_stock' | 'out_of_stock' | 'unavailable' | 'unknown';
  priority: number;
  health?: { availability?: unknown; [key: string]: unknown };
  lastSyncAt: string;
  enabled: boolean;
  reviewStatus: 'review_pending' | 'approved' | 'rejected' | 'suppressed';
}

export interface SupplierOfferSelectionView {
  activeOfferId: string | null;
  lockedOfferId: string | null;
  failoverEnabled: boolean;
}

export interface SupplierOffersResponse {
  success: boolean;
  productId: string;
  offers: SupplierOfferView[];
  selection: SupplierOfferSelectionView;
  error?: string;
}

export const supplierOfferIsActive = (offer: SupplierOfferView, selection: SupplierOfferSelectionView): boolean => (
  offer.id === selection.activeOfferId
);

export const supplierOfferIsLocked = (offer: SupplierOfferView, selection: SupplierOfferSelectionView): boolean => (
  offer.id === selection.lockedOfferId
);

export function sortSupplierOffers(offers: readonly SupplierOfferView[]): SupplierOfferView[] {
  return [...offers].sort((left, right) => right.priority - left.priority || left.sourceId.localeCompare(right.sourceId));
}
