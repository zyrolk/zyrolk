const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ERROR_MESSAGE = 'The service is temporarily unavailable. Please try again.';

export class NetworkRequestError extends Error {
  readonly status?: number;
  readonly kind: 'http' | 'network' | 'timeout' | 'invalid-response';

  constructor(message: string, kind: NetworkRequestError['kind'], status?: number) {
    super(message);
    this.name = 'NetworkRequestError';
    this.kind = kind;
    this.status = status;
  }
}

interface FetchJsonOptions {
  timeoutMs?: number;
  fallbackMessage?: string;
  fetchImpl?: typeof fetch;
}

const extractErrorMessage = (value: unknown, fallbackMessage: string): string => {
  if (!value || typeof value !== 'object') return fallbackMessage;
  const candidate = (value as { error?: unknown }).error;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 300) : fallbackMessage;
};

export async function fetchJson<T>(input: RequestInfo | URL, init: RequestInit = {}, options: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallbackMessage = options.fallbackMessage || DEFAULT_ERROR_MESSAGE;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    let body: unknown = null;

    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        if (!response.ok) throw new NetworkRequestError(fallbackMessage, 'http', response.status);
        throw new NetworkRequestError('The service returned an invalid response. Please try again.', 'invalid-response', response.status);
      }
    }

    if (!response.ok) {
      throw new NetworkRequestError(extractErrorMessage(body, fallbackMessage), 'http', response.status);
    }

    return body as T;
  } catch (error) {
    if (error instanceof NetworkRequestError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new NetworkRequestError('The request timed out. Check your connection and try again.', 'timeout');
    }
    throw new NetworkRequestError('Unable to reach Zyro.lk. Check your connection and try again.', 'network');
  } finally {
    clearTimeout(timeoutId);
  }
}
