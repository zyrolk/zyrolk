export const GUEST_ORDER_RECOVERY_STORAGE_KEY = 'zyro.guest-order-recovery.v1';
export const GUEST_ORDER_RECOVERY_TOKEN_BYTES = 32;
export const GUEST_ORDER_RECOVERY_TOKEN_LENGTH = 43;

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredRecoveryState {
  version: 1;
  pending?: {
    token: string;
    fingerprint: string;
  };
  latestToken?: string;
}

const browserStorage = (): RecoveryStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const isStorage = (value: RecoveryStorage | null | undefined): value is RecoveryStorage => Boolean(
  value
  && typeof value.getItem === 'function'
  && typeof value.setItem === 'function'
  && typeof value.removeItem === 'function',
);

export function isGuestOrderRecoveryToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === GUEST_ORDER_RECOVERY_TOKEN_LENGTH
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export function generateGuestOrderRecoveryToken(): string | null {
  try {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues || typeof btoa !== 'function') return null;
    const bytes = cryptoApi.getRandomValues(new Uint8Array(GUEST_ORDER_RECOVERY_TOKEN_BYTES));
    const token = encodeBase64Url(bytes);
    return isGuestOrderRecoveryToken(token) ? token : null;
  } catch {
    return null;
  }
}

const readState = (storage: RecoveryStorage | null): StoredRecoveryState => {
  if (!isStorage(storage)) return { version: 1 };
  try {
    const parsed = JSON.parse(storage.getItem(GUEST_ORDER_RECOVERY_STORAGE_KEY) || '') as Partial<StoredRecoveryState>;
    const pending = parsed?.pending;
    return {
      version: 1,
      ...(pending
        && typeof pending === 'object'
        && isGuestOrderRecoveryToken(pending.token)
        && typeof pending.fingerprint === 'string'
        && pending.fingerprint.length <= 128
        ? { pending: { token: pending.token, fingerprint: pending.fingerprint } }
        : {}),
      ...(isGuestOrderRecoveryToken(parsed?.latestToken) ? { latestToken: parsed.latestToken } : {}),
    };
  } catch {
    return { version: 1 };
  }
};

const writeState = (storage: RecoveryStorage | null, state: StoredRecoveryState): void => {
  if (!isStorage(storage)) return;
  try {
    storage.setItem(GUEST_ORDER_RECOVERY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A blocked or full browser store must not block checkout.
  }
};

const fingerprintFor = async (signature: string): Promise<string> => {
  try {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle || typeof TextEncoder === 'undefined') return '';
    const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(signature));
    return encodeBase64Url(new Uint8Array(digest));
  } catch {
    return '';
  }
};

export async function prepareGuestOrderRecoveryToken(
  checkoutSignature: string,
  storage: RecoveryStorage | null = browserStorage(),
): Promise<string | null> {
  const fingerprint = await fingerprintFor(checkoutSignature);
  const state = readState(storage);
  if (fingerprint && state.pending?.fingerprint === fingerprint) return state.pending.token;

  const token = generateGuestOrderRecoveryToken();
  if (!token) return null;
  writeState(storage, {
    version: 1,
    ...(fingerprint ? { pending: { token, fingerprint } } : {}),
    ...(state.latestToken ? { latestToken: state.latestToken } : {}),
  });
  return token;
}

export function readGuestOrderRecoveryToken(storage: RecoveryStorage | null = browserStorage()): string | null {
  return readGuestOrderRecoveryCandidates(storage)[0] || null;
}

export function readGuestOrderRecoveryCandidates(
  storage: RecoveryStorage | null = browserStorage(),
): string[] {
  const state = readState(storage);
  return [...new Set([
    state.pending?.token,
    state.latestToken,
  ].filter((candidate): candidate is string => isGuestOrderRecoveryToken(candidate)))];
}

export function promoteGuestOrderRecoveryToken(
  token: string,
  storage: RecoveryStorage | null = browserStorage(),
): void {
  if (!isGuestOrderRecoveryToken(token)) return;
  const state = readState(storage);
  writeState(storage, {
    version: 1,
    latestToken: token,
    ...(state.pending?.token === token ? {} : state.pending ? { pending: state.pending } : {}),
  });
}

export function clearGuestOrderRecoveryToken(storage: RecoveryStorage | null = browserStorage()): void {
  if (!isStorage(storage)) return;
  try { storage.removeItem(GUEST_ORDER_RECOVERY_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}
