export const SUPPLIER_QUEUE_DEFAULT_RETRY_LIMIT = 5;

export function buildSupplierQueueLifecycle(createdAt = new Date().toISOString()): Record<string, unknown> {
  return {
    queueState: "queued",
    retryCount: 0,
    retryLimit: SUPPLIER_QUEUE_DEFAULT_RETRY_LIMIT,
    nextRetryAt: createdAt,
    queueCreatedAt: createdAt,
  };
}

export function buildSupplierOfferRemovalReviewId(
  offerId: string,
  lifecycleVersion = 0,
  previousLifecycleTerminal = false,
): string {
  const baseId = `reconcile-offer-${offerId}`.slice(0, 180);
  if (!previousLifecycleTerminal) return baseId;
  const suffix = `-v${Math.max(0, Math.floor(lifecycleVersion))}`;
  return `${baseId.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}
