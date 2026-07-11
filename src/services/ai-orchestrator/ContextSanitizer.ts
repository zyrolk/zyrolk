const CIRCULAR_REFERENCE = '[Circular]';
const ALWAYS_SENSITIVE = new Set([
  'email', 'customeremail', 'phone', 'phone2', 'customerphone', 'customerphone2',
  'address', 'customeraddress', 'uid', 'userid', 'customeruid', 'authid',
  'authenticationid', 'accesstoken', 'idtoken', 'refreshtoken',
  'customername', 'displayname', 'username',
]);
const IDENTITY_CONTAINERS = new Set(['customer', 'user', 'account', 'auth', 'authentication']);
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function normalized(value: string): string { return value.replace(/[^a-z0-9]/gi, '').toLowerCase(); }

function isSensitive(key: string, path: readonly string[]): boolean {
  const normalizedKey = normalized(key);
  if (ALWAYS_SENSITIVE.has(normalizedKey)) return true;
  const parent = normalized(path[path.length - 1] || '');
  return ['name', 'firstname', 'lastname'].includes(normalizedKey) && IDENTITY_CONTAINERS.has(parent);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

export class ContextSanitizer {
  sanitize(input: unknown): unknown {
    const seen = new WeakSet<object>();
    const visit = (value: unknown, path: readonly string[]): unknown => {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      if (typeof value !== 'object') return undefined;
      if (seen.has(value)) return CIRCULAR_REFERENCE;
      seen.add(value);
      if (Array.isArray(value)) return value.map((item) => visit(item, path)).filter((item) => item !== undefined);
      const output: Record<string, unknown> = {};
      Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
        if (PROTOTYPE_KEYS.has(key) || isSensitive(key, path)) return;
        const sanitized = visit(child, [...path, key]);
        if (sanitized !== undefined) output[key] = sanitized;
      });
      return output;
    };
    return deepFreeze(visit(input, []));
  }
}
