/** Conservative launch default: pending COD orders survive overnight until staff return. */
export const DEFAULT_COD_PENDING_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum configurable TTL. Values below this fall back to the launch default. */
export const MIN_COD_PENDING_ORDER_TTL_MS = 2 * 60 * 60 * 1000;

/** Maximum configurable TTL (7 days). */
export const MAX_COD_PENDING_ORDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @deprecated Prefer `resolveCodPendingOrderTtlMs(settings)`. Launch default is 24 hours.
 * Kept for backward-compatible imports while checkout reads server-owned settings.
 */
export const COD_CONFIRMATION_WINDOW_MS = DEFAULT_COD_PENDING_ORDER_TTL_MS;

const HOUR_MS = 60 * 60 * 1000;

export function resolveCodPendingOrderTtlMs(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): number {
  const configured = settings?.codPendingOrderTtlHours;
  if (configured === undefined || configured === null || configured === "") {
    return DEFAULT_COD_PENDING_ORDER_TTL_MS;
  }
  const hours = Number(configured);
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_COD_PENDING_ORDER_TTL_MS;
  }
  const ttlMs = Math.trunc(hours * HOUR_MS);
  if (ttlMs < MIN_COD_PENDING_ORDER_TTL_MS || ttlMs > MAX_COD_PENDING_ORDER_TTL_MS) {
    return DEFAULT_COD_PENDING_ORDER_TTL_MS;
  }
  return ttlMs;
}

export function resolveCodReservationExpiresAt(
  nowMs: number,
  settings: Readonly<Record<string, unknown>> | null | undefined,
): Date {
  return new Date(nowMs + resolveCodPendingOrderTtlMs(settings));
}
