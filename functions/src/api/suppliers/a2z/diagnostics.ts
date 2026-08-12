export function getCookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(/,(?=[^;]*=)/)
    .map((header) => header.split(";", 1)[0]?.split("=", 1)[0]?.trim())
    .filter((name): name is string => Boolean(name));
}

export function sanitizeA2ZResponseHeaders(headers: Headers): Record<string, string> {
  const allowedHeaders = new Set(["content-length", "content-type", "date", "retry-after", "server", "x-request-id"]);
  const sanitized: Record<string, string> = {};

  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized === "set-cookie") {
      sanitized[normalized] = `[redacted; cookie-names=${getCookieNames(value).join(",") || "unknown"}]`;
    } else if (allowedHeaders.has(normalized)) {
      sanitized[normalized] = value.slice(0, 500);
    }
  });

  return sanitized;
}

export function sanitizeA2ZResponseBody(body: string): string {
  return `[redacted supplier response body; length=${body.length}]`;
}
