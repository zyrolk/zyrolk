export type SupplierSyncMode = 'full' | 'incremental';

export type SupplierSyncFilterExecution = 'supplier_native' | 'server_side' | 'unsupported';

export interface SupplierSyncCapabilities {
  incremental?: {
    supported?: boolean;
    mechanism?: 'updated_since' | 'delta_token' | 'change_cursor' | 'unsupported';
    deletionSemantics?: 'tombstones' | 'none';
  };
  categoryFilter?: SupplierSyncFilterExecution;
  subcategoryFilter?: SupplierSyncFilterExecution;
  searchFilter?: SupplierSyncFilterExecution;
}

export interface SupplierManualSyncRequest {
  sourceIds: string[];
  mode: SupplierSyncMode;
  filters?: {
    category?: string;
    subcategory?: string;
    search?: string;
  };
  totalProductLimit?: number;
  catalogContinuation?: 'continue' | 'restart';
}

export interface SupplierManualSyncDraft {
  sourceId: string;
  mode: SupplierSyncMode;
  category?: string;
  subcategory?: string;
  search?: string;
  totalProductLimit?: string | number | null;
  catalogContinuation?: 'continue' | 'restart';
  capabilities?: SupplierSyncCapabilities | null;
}

const cleanText = (value: unknown, maximum: number): string => String(value || '')
  .normalize('NFKC')
  .trim()
  .slice(0, maximum);

export const supplierSyncFilterIsSupported = (value: unknown): value is Exclude<SupplierSyncFilterExecution, 'unsupported'> => (
  value === 'supplier_native' || value === 'server_side'
);

export const supplierSyncFilterExecutionLabel = (value: SupplierSyncFilterExecution | undefined): string => (
  value === 'supplier_native' ? 'Supplier-side' : value === 'server_side' ? 'Applied by Zyro after retrieval' : 'Unsupported'
);

/**
 * Builds the safe browser request contract. Functions remain authoritative for
 * validation; this helper prevents the UI from advertising or sending controls
 * that the projected connector capability profile marks unsupported.
 */
export function buildSupplierManualSyncRequest(draft: SupplierManualSyncDraft): SupplierManualSyncRequest {
  const sourceId = cleanText(draft.sourceId, 160);
  if (!sourceId || sourceId.includes('/')) throw new Error('A valid supplier source is required.');

  const capabilities = draft.capabilities || {};
  if (draft.mode === 'incremental' && capabilities.incremental?.supported !== true) {
    throw new Error('Incremental Sync is not supported by this supplier connection.');
  }

  const filters: NonNullable<SupplierManualSyncRequest['filters']> = {};
  const category = cleanText(draft.category, 160);
  const subcategory = cleanText(draft.subcategory, 160);
  const search = cleanText(draft.search, 120);
  if (category && supplierSyncFilterIsSupported(capabilities.categoryFilter)) filters.category = category;
  if (subcategory && supplierSyncFilterIsSupported(capabilities.subcategoryFilter)) filters.subcategory = subcategory;
  if (search && supplierSyncFilterIsSupported(capabilities.searchFilter)) filters.search = search;

  const limitText = String(draft.totalProductLimit ?? '').trim();
  let totalProductLimit: number | undefined;
  if (limitText) {
    const parsed = Number(limitText);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
      throw new Error('Product count limit must be a whole number from 1 to 10,000.');
    }
    totalProductLimit = parsed;
  }

  return {
    sourceIds: [sourceId],
    mode: draft.mode,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(totalProductLimit !== undefined ? { totalProductLimit } : {}),
    ...(draft.catalogContinuation ? { catalogContinuation: draft.catalogContinuation } : {}),
  };
}

export interface SupplierCatalogContinuationCheckpoint {
  status?: string;
  terminationReason?: string | null;
  cursor?: string | null;
}

/** Continue is only offered when a prior limited run left a safe forward cursor. */
export function isSupplierCatalogContinuationResumable(
  catalogSync?: SupplierCatalogContinuationCheckpoint | null,
): boolean {
  if (!catalogSync?.cursor) return false;
  const status = String(catalogSync.status || '').trim().toLowerCase();
  const reason = String(catalogSync.terminationReason || '').trim().toLowerCase();
  if (status === 'completed') return false;
  return status === 'limited' && reason === 'limit_reached';
}
