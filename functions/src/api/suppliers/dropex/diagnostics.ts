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
