const CHECKOUT_IDEMPOTENCY_STORAGE_KEY = 'zyro.checkout.idempotency';

export interface CheckoutIdempotencyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CheckoutAttempt {
  signature: string;
  key: string;
}

let inMemoryAttempt: CheckoutAttempt | null = null;

export function getCheckoutSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isUsableKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return key.length > 0 && key.length <= 200 && !/[\u0000-\u001F\u007F]/u.test(key);
}

function createIdempotencyKey(): string {
  const cryptoSource = typeof window === 'undefined' ? undefined : window.crypto;
  return cryptoSource?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Returns one key for the active checkout request signature. The in-memory
 * record is deliberately retained when sessionStorage is unavailable so a
 * retry after an unknown response cannot create a second order.
 */
export function getCheckoutIdempotencyKey(
  signature: string,
  storage: CheckoutIdempotencyStorage | null = getCheckoutSessionStorage(),
): string {
  if (!signature) throw new Error('Checkout signature is required');

  try {
    const stored = JSON.parse(storage?.getItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY) || '{}') as {
      key?: unknown;
      signature?: unknown;
    };
    if (isUsableKey(stored.key) && stored.signature === signature) {
      const key = stored.key.trim();
      inMemoryAttempt = { signature, key };
      return key;
    }
    if (isUsableKey(stored.key)) {
      const key = stored.key.trim();
      inMemoryAttempt = {
        signature: typeof stored.signature === 'string' ? stored.signature : signature,
        key,
      };
      return key;
    }
  } catch {
    // The in-memory attempt below is the safe fallback for blocked storage.
  }

  if (inMemoryAttempt && isUsableKey(inMemoryAttempt.key)) {
    return inMemoryAttempt.key;
  }

  const key = createIdempotencyKey();
  inMemoryAttempt = { signature, key };
  try {
    storage?.setItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key, signature }));
  } catch {
    // Keep the active attempt in memory when storage is read-only or blocked.
  }
  return key;
}

export function clearCheckoutIdempotencyKey(
  storage: CheckoutIdempotencyStorage | null = getCheckoutSessionStorage(),
): void {
  inMemoryAttempt = null;
  try {
    storage?.removeItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
  } catch {
    // Session storage may be unavailable.
  }
}
