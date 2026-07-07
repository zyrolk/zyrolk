import { Product, SupplierReviewQueueItem } from '../../types';
import { 
  InboundProduct, 
  ProductComparisonResult, 
  ImportQueueEntry, 
  SyncHistoryEntry 
} from '../sync-engine/types';

export interface SandboxProductPreview {
  sku: string;
  name: string;
  action: 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR';
  reasons: string[];
  comparison?: ProductComparisonResult;
  validationErrors?: string[];
  isDuplicate: boolean;
  hasMissingRequiredFields: boolean;
  hasInvalidImages: boolean;
  mappedInbound?: InboundProduct;
}

export interface SandboxSummary {
  totalProducts: number;
  newProducts: number;
  updates: number;
  skipped: number;
  errors: number;
  totalImages: number;
  queueSize: number; // Projected queue size for image downloads
}

export interface SandboxPreviewReport {
  sessionId: string;
  supplierId: string;
  supplierName: string;
  timestamp: string;
  summary: SandboxSummary;
  previews: SandboxProductPreview[];
  duplicateSkuCodes: string[];
  missingRequiredFieldsSkuCodes: string[];
  invalidImagesSkuCodes: string[];
}

export interface SandboxApprovalPayload {
  sessionId: string;
  supplierId: string;
  supplierName: string;
  timestamp: string;
  // Prepared Firestore-compatible documents to write upon approval
  productsToCreate: Product[];
  productsToUpdate: Array<{ id: string; updates: Partial<Product> }>;
  reviewQueueItems: SupplierReviewQueueItem[];
  pendingChangesItems: any[];
  importQueueEntries: ImportQueueEntry[];
  syncHistoryEntry: SyncHistoryEntry;
}

export interface SandboxRollbackPayload {
  sessionId: string;
  supplierId: string;
  timestamp: string;
  // State before sandbox changes were prepared, allowing complete reversal
  originalProducts: Product[];
  createdProductIds: string[]; // IDs to delete upon rollback
}

export interface SandboxSessionState {
  id: string;
  supplierId: string;
  supplierName: string;
  status: 'initialized' | 'analyzed' | 'approved' | 'rolled_back' | 'expired';
  config: any;
  createdAt: string;
  analyzedAt?: string;
  report?: SandboxPreviewReport;
  approvalPayload?: SandboxApprovalPayload;
  rollbackPayload?: SandboxRollbackPayload;
}
