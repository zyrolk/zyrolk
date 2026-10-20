export function sanitizeDropexResponseHeaders(headers: Headers): Record<string, string> {
  const allowedHeaders = new Set(["content-length", "content-type", "date", "retry-after", "server", "x-request-id"]);
  const sanitized: Record<string, string> = {};

  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized === "authorization" || normalized === "set-cookie") {
      sanitized[normalized] = "[redacted]";
    } else if (allowedHeaders.has(normalized)) {
      sanitized[normalized] = value.slice(0, 500);
    }
  });

  return sanitized;
}

export function sanitizeDropexResponseBody(body: string): string {
  return `[redacted supplier response body; length=${body.length}]`;
}

export type DropexDiagnosticOperationPhase =
  | "login"
  | "exact_catalog_page"
  | "category_lookup"
  | "product_dto_enrichment"
  | "identity_response_parsing";

export type DropexDiagnosticPhase = DropexDiagnosticOperationPhase | "deadline_abort_rate_limit";

export type DropexDiagnosticClassification =
  | "AUTH"
  | "HTTP_ERROR"
  | "PARSE_ERROR"
  | "IDENTITY_MISMATCH"
  | "TIMEOUT"
  | "ABORT"
  | "RATE_LIMIT"
  | "CAPACITY"
  | "UNKNOWN";

export interface DropexFailureDiagnostic {
  phase: DropexDiagnosticPhase;
  operationPhase: DropexDiagnosticOperationPhase;
  classification: DropexDiagnosticClassification;
  durationMs: number;
  httpStatus?: number;
  page?: number;
  timedOut?: boolean;
  aborted?: boolean;
  rateLimited?: boolean;
}

interface DropexDiagnosticCarrier {
  readonly __dropexFailureDiagnostic?: DropexFailureDiagnostic;
}

const clampDuration = (value: number): number => Math.max(0, Math.min(300_000, Math.floor(value)));

const safeHttpStatus = (value: unknown): number | undefined => {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
};

const safePage = (value: unknown): number | undefined => {
  const page = Number(value);
  return Number.isInteger(page) && page >= 0 ? page : undefined;
};

const errorStatus = (error: unknown): number | undefined => safeHttpStatus(
  (error as { status?: unknown; statusCode?: unknown })?.status
    ?? (error as { status?: unknown; statusCode?: unknown })?.statusCode,
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message.toLocaleLowerCase() : ""
);

export function classifyDropexFailure(error: unknown): DropexDiagnosticClassification {
  const status = errorStatus(error);
  const message = errorMessage(error);
  if (status === 429 || message.includes("rate limit")) return "RATE_LIMIT";
  if ((error instanceof Error && error.name === "AbortError") || message.includes("aborted")) return "ABORT";
  if (
    status === 408
    || message.includes("timed out")
    || message.includes("time bound")
    || message.includes("deadline")
    || message.includes("timeout")
  ) return "TIMEOUT";
  if (
    status === 401
    || status === 403
    || message.includes("authentication")
    || message.includes("credentials are required")
  ) return "AUTH";
  if (status !== undefined && status >= 400) return "HTTP_ERROR";
  if (message.includes("parse") || message.includes("valid json") || message.includes("malformed json")) {
    return "PARSE_ERROR";
  }
  if (
    message.includes("unexpected supplier identity")
    || message.includes("multiple catalogue rows")
    || message.includes("identity")
  ) return "IDENTITY_MISMATCH";
  if (message.includes("capacity is temporarily unavailable")) return "CAPACITY";
  return "UNKNOWN";
}

export function buildDropexFailureDiagnostic(
  error: unknown,
  operationPhase: DropexDiagnosticOperationPhase,
  durationMs: number,
  details: Pick<DropexFailureDiagnostic, "httpStatus" | "page"> = {},
): DropexFailureDiagnostic {
  const classification = classifyDropexFailure(error);
  const crossCuttingFailure = classification === "TIMEOUT"
    || classification === "ABORT"
    || classification === "RATE_LIMIT";
  return {
    phase: crossCuttingFailure ? "deadline_abort_rate_limit" : operationPhase,
    operationPhase,
    classification,
    durationMs: clampDuration(durationMs),
    ...(safeHttpStatus(details.httpStatus ?? errorStatus(error)) !== undefined
      ? { httpStatus: safeHttpStatus(details.httpStatus ?? errorStatus(error)) }
      : {}),
    ...(safePage(details.page) !== undefined ? { page: safePage(details.page) } : {}),
    ...(classification === "TIMEOUT" ? { timedOut: true } : {}),
    ...(classification === "ABORT" ? { aborted: true } : {}),
    ...(classification === "RATE_LIMIT" ? { rateLimited: true } : {}),
  };
}

export function attachDropexFailureDiagnostic(
  error: unknown,
  diagnostic: DropexFailureDiagnostic,
): DropexFailureDiagnostic {
  if (error && typeof error === "object") {
    const carrier = error as DropexDiagnosticCarrier;
    if (carrier.__dropexFailureDiagnostic) return carrier.__dropexFailureDiagnostic;
    Object.defineProperty(carrier, "__dropexFailureDiagnostic", {
      configurable: true,
      enumerable: false,
      value: diagnostic,
      writable: false,
    });
  }
  return diagnostic;
}

export function getDropexFailureDiagnostic(error: unknown): DropexFailureDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as DropexDiagnosticCarrier).__dropexFailureDiagnostic;
}
