import { logger } from "firebase-functions";

type LogContext = Record<string, unknown>;

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "password",
  "token",
  "idtoken",
  "apikey",
  "api_key",
  "secret",
  "credential",
  "credentials",
  "session",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return SENSITIVE_KEYS.some((sensitiveKey) => normalized.includes(sensitiveKey));
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (isSensitiveKey(key)) {
    return "[REDACTED]";
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (depth > 4) {
    return "[TRUNCATED]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, key, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [entryKey, entryValue]) => {
      acc[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1);
      return acc;
    }, {});
  }

  return value;
}

export function sanitizeLogContext(context: LogContext = {}): LogContext {
  return sanitizeValue(context) as LogContext;
}

export const appLogger = {
  info(message: string, context: LogContext = {}): void {
    logger.info(message, sanitizeLogContext(context));
  },

  warn(message: string, context: LogContext = {}): void {
    logger.warn(message, sanitizeLogContext(context));
  },

  error(message: string, context: LogContext = {}): void {
    logger.error(message, sanitizeLogContext(context));
  },
};
