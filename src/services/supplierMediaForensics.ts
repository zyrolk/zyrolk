import { getSupplierApi } from './supplierHubApi';

export interface SupplierMediaForensicEvidence {
  supplier: string | null;
  supplierSku: string | null;
  supplierProductId: string | null;
  reviewId: string;
  queue: {
    state: string | null;
    eligibleNow: boolean | null;
    eligibilityReasons: string[];
    createdAt: string | null;
    updatedAt: string | null;
  };
  lease: {
    active: boolean | null;
    leaseId: string | null;
    acquiredAt: string | null;
    expiresAt: string | null;
    expired: boolean | null;
  };
  retry: {
    retryCount: number | null;
    retryLimit: number | null;
    nextRetryAt: string | null;
    retryable: boolean | null;
    exhausted: boolean | null;
  };
  worker: {
    lastAttemptAt: string | null;
    lastAttemptResult: string | null;
    attemptCount: number | null;
    health: {
      schedule: string;
      status: string | null;
      lastObservedExecution: string | null;
      lastSuccess: string | null;
      lastFailure: string | null;
      attempted: number | null;
      completed: number | null;
      leaseRecoveries: number | null;
    };
  };
  media: {
    sourceImageCount: number | null;
    managedImageCount: number | null;
    usablePrimaryImage: boolean | null;
    readiness: 'ready' | 'blocked' | 'unknown';
    lastActivityAt: string | null;
    safeFailureClass: string;
  };
  finalization: {
    assetPersisted: boolean | null;
    readinessProjected: boolean | null;
    reviewStateUpdated: boolean | null;
    auditEvents: string[];
  };
  diagnosis: {
    possiblyStuck: boolean;
    blockingPredicate: string | null;
    nextExpectedTransition: string | null;
  };
}

export async function fetchSupplierMediaForensics(input: {
  queueItemId?: string;
  supplierSku?: string;
}): Promise<SupplierMediaForensicEvidence> {
  const parameters = new URLSearchParams();
  if (input.queueItemId) parameters.set('queueItemId', input.queueItemId);
  if (input.supplierSku) parameters.set('supplierSku', input.supplierSku);
  const response = await getSupplierApi(`/api/supplier-review-queue/diagnostics?${parameters.toString()}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.diagnostic) {
    throw new Error(body?.error || 'Supplier media diagnostics could not be loaded.');
  }
  return body.diagnostic as SupplierMediaForensicEvidence;
}
