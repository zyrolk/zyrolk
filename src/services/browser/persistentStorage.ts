export type BrowserStorageKind = 'localStorage' | 'sessionStorage';

export function getBrowserStorage(kind: BrowserStorageKind): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export function readStoredArray<T>(storage: Storage | null, key: string): T[] {
  if (!storage) return [];
  try {
    const rawValue = storage.getItem(key);
    if (!rawValue) return [];
    const parsedValue: unknown = JSON.parse(rawValue);
    return Array.isArray(parsedValue) ? parsedValue as T[] : [];
  } catch {
    return [];
  }
}

export function readStoredJson<T>(storage: Storage | null, key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  if (!storage) return fallback;
  try {
    const rawValue = storage.getItem(key);
    if (!rawValue) return fallback;
    const parsedValue: unknown = JSON.parse(rawValue);
    return isValid(parsedValue) ? parsedValue : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(storage: Storage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
