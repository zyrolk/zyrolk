export const ORDER_EMAIL_MAX_ATTEMPTS = 3;
export const ORDER_EMAIL_RETRY_BASE_MS = 5 * 60 * 1000;

export type OrderEmailDeliveryStatus = "handed_off" | "delivering" | "delivered" | "retry_pending" | "failed";

export interface OrderEmailDeliveryProjection {
  status: OrderEmailDeliveryStatus;
  shouldRetry: boolean;
  nextRetryAtMillis?: number;
}

export function orderEmailRetryDelay(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(60 * 60 * 1000, ORDER_EMAIL_RETRY_BASE_MS * (2 ** (safeAttempt - 1)));
}

export function projectOrderEmailDelivery(
  providerState: unknown,
  attempt: number,
  now = Date.now(),
  maxAttempts = ORDER_EMAIL_MAX_ATTEMPTS,
): OrderEmailDeliveryProjection {
  const state = String(providerState || "").trim().toUpperCase();
  if (["SUCCESS", "DELIVERED", "SENT"].includes(state)) {
    return { status: "delivered", shouldRetry: false };
  }
  if (["ERROR", "FAILED", "FAILURE"].includes(state)) {
    const shouldRetry = attempt < maxAttempts;
    return shouldRetry
      ? { status: "retry_pending", shouldRetry: true, nextRetryAtMillis: now + orderEmailRetryDelay(attempt) }
      : { status: "failed", shouldRetry: false };
  }
  if (["PROCESSING", "DELIVERING"].includes(state)) {
    return { status: "delivering", shouldRetry: false };
  }
  return { status: "handed_off", shouldRetry: false };
}

export function safeOrderEmailFailure(value: unknown): string {
  const candidate = typeof value === "string"
    ? value
    : value && typeof value === "object" && "message" in value
      ? String((value as { message?: unknown }).message || "")
      : "";
  return candidate.trim().replace(/[\u0000-\u001F\u007F]/gu, "").slice(0, 500) || "Email provider reported a delivery failure.";
}
