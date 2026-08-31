const MAX_RETRY_AFTER_MS = 60_000;

export class A2ZHttpError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "A2ZHttpError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.floor(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const retryAt = Date.parse(raw);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - now), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

export function classifyA2ZHttpStatus(status: number, retryAfterHeader?: string | null, now = Date.now()): A2ZHttpError | null {
  if (status === 200) return null;
  if (status === 429) {
    return new A2ZHttpError(
      `A2Z catalogue request was rate limited (HTTP ${status}).`,
      status,
      true,
      parseRetryAfterMs(retryAfterHeader, now),
    );
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return new A2ZHttpError(
      `A2Z catalogue service is temporarily unavailable (HTTP ${status}).`,
      status,
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new A2ZHttpError(
      `A2Z catalogue authentication failed (HTTP ${status}).`,
      status,
      false,
    );
  }
  return new A2ZHttpError(
    `A2Z catalogue request failed (HTTP ${status}).`,
    status,
    false,
  );
}

export const A2Z_TRANSIENT_HTTP_MAX_ATTEMPTS = 3;

export function transientRetryDelayMs(error: A2ZHttpError, attempt: number): number {
  if (error.retryAfterMs && error.retryAfterMs > 0) return error.retryAfterMs;
  return Math.min(15_000, 1_000 * attempt);
}
