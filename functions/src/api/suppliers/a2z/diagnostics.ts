export function getCookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(/,(?=[^;]*=)/)
    .map((header) => header.split(";", 1)[0]?.split("=", 1)[0]?.trim())
    .filter((name): name is string => Boolean(name));
}

export function sanitizeA2ZResponseHeaders(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {};

  headers.forEach((value, key) => {
    sanitized[key] = key.toLowerCase() === "set-cookie"
      ? `[redacted; cookie-names=${getCookieNames(value).join(",") || "unknown"}]`
      : value.slice(0, 500);
  });

  return sanitized;
}

export function sanitizeA2ZResponseBody(body: string): string {
  return body.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
