export const DEFAULT_MAX_CONTEXT_SIZE = 32 * 1024;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export interface AIUsagePolicy {
  readonly mode: 'read-only';
  readonly approvalRequiredActions: readonly string[];
  readonly maxContextSize: number;
  readonly timeoutMs: number;
  readonly retry: {
    readonly automatic: false;
    readonly maxAttempts: 1;
  };
  readonly futureRateLimit: {
    readonly enabled: false;
    readonly windowMs: number;
    readonly maxRequests: null;
  };
}

export const AI_USAGE_POLICY: AIUsagePolicy = Object.freeze({
  mode: 'read-only',
  approvalRequiredActions: Object.freeze([
    'product-change', 'pricing-change', 'inventory-change', 'supplier-approval',
    'marketing-publication', 'order-change',
  ]),
  maxContextSize: DEFAULT_MAX_CONTEXT_SIZE,
  timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  retry: Object.freeze({ automatic: false, maxAttempts: 1 }),
  futureRateLimit: Object.freeze({ enabled: false, windowMs: 60_000, maxRequests: null }),
});
