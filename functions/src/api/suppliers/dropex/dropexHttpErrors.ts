const MAX_RETRY_AFTER_MS = 60_000;

export class DropexHttpError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "DropexHttpError";
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

export function classifyDropexHttpStatus(status: number, retryAfterHeader?: string | null, now = Date.now()): DropexHttpError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    return new DropexHttpError(
      `Dropex request was rate limited (HTTP ${status}).`,
      status,
      true,
      parseRetryAfterMs(retryAfterHeader, now),
    );
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return new DropexHttpError(
      `Dropex service is temporarily unavailable (HTTP ${status}).`,
      status,
      true,
    );
  }
  if (status === 401 || status === 403) {
    return new DropexHttpError(
      `Dropex authentication failed (HTTP ${status}).`,
      status,
      false,
    );
  }
  if (status === 408) {
    return new DropexHttpError("Dropex request timed out.", status, true);
  }
  return new DropexHttpError(
    `Dropex request failed (HTTP ${status}).`,
    status,
    false,
  );
}

export const DROPEX_TRANSIENT_HTTP_MAX_ATTEMPTS = 3;

export function transientRetryDelayMs(error: DropexHttpError, attempt: number): number {
  if (error.retryAfterMs && error.retryAfterMs > 0) return error.retryAfterMs;
  return Math.min(15_000, 1_000 * attempt);
}
