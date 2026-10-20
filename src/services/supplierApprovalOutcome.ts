export interface SupplierApprovalResponse {
  success?: boolean;
  action?: string;
  status?: string;
  productId?: unknown;
  approvalAuditId?: unknown;
  publicationStatus?: string;
  error?: string;
}

export const SUPPLIER_APPROVAL_UNKNOWN_MESSAGE =
  'Approval status is UNKNOWN/PENDING. No publication was confirmed; refresh Product Review and Review History before retrying.';

const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();
const nonEmptyText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * A publish success is only displayable when the server has returned the
 * additive proof fields written by the same approval transaction.
 */
export function isDurablyCommittedSupplierApproval(result: SupplierApprovalResponse): boolean {
  return result.success === true
    && normalized(result.action) === 'approved'
    && normalized(result.status) === 'approved'
    && normalized(result.publicationStatus) === 'committed'
    && nonEmptyText(result.productId)
    && nonEmptyText(result.approvalAuditId);
}

export function supplierApprovalOutcome(result: SupplierApprovalResponse): 'committed' | 'failed' | 'unknown' {
  if (result.success !== true) return 'failed';
  return isDurablyCommittedSupplierApproval(result) ? 'committed' : 'unknown';
}

export class SupplierApprovalUnknownError extends Error {
  readonly code = 'SUPPLIER_APPROVAL_UNKNOWN';

  constructor(cause?: unknown) {
    super(SUPPLIER_APPROVAL_UNKNOWN_MESSAGE);
    this.name = 'SupplierApprovalUnknownError';
    if (cause !== undefined) this.cause = cause;
  }
}

export function isSupplierApprovalUnknownError(error: unknown): boolean {
  return error instanceof SupplierApprovalUnknownError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SUPPLIER_APPROVAL_UNKNOWN');
}
