import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { IncomingHttpHeaders, RequestOptions } from "node:http";
import { LookupFunction } from "node:net";
import { appLogger } from "../logging";
import {
  defaultSupplierHostResolver,
  HostResolver,
  SupplierUrlValidationError,
  validateSupplierOutboundUrl,
  ValidatedSupplierTarget,
} from "./supplierUrlProtection";

const DEFAULT_MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "origin", "referer", "host"]);

export interface SupplierOutboundPolicy {
  approvedHosts: string[];
  connector: string;
  sourceId?: string;
  maxRedirects?: number;
  resolveHost?: HostResolver;
}

export interface SupplierOutboundResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  json: <T = unknown>() => Promise<T>;
}

export type SupplierOutboundTransport = (
  target: ValidatedSupplierTarget,
  init: RequestInit,
) => Promise<SupplierOutboundResponse>;

const headersToRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const responseHeaders = (headers: IncomingHttpHeaders): Headers => {
  const normalized = new Headers();
  Object.entries(headers).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => normalized.append(key, entry));
    } else if (typeof value === "string") {
      normalized.set(key, value);
    }
  });
  return normalized;
};

const isDifferentHost = (left: string, right: string): boolean => new URL(left).host.toLowerCase() !== new URL(right).host.toLowerCase();

export const createPinnedLookup = (address: string): LookupFunction => {
  const family = address.includes(":") ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
};

const removeSensitiveHeaders = (headers: HeadersInit | undefined): Headers => {
  const sanitized = new Headers(headers);
  SENSITIVE_REDIRECT_HEADERS.forEach((header) => sanitized.delete(header));
  return sanitized;
};

const redirectInit = (init: RequestInit, fromUrl: string, toUrl: string, status: number): RequestInit => {
  const method = (init.method || "GET").toUpperCase();
  const mustSwitchToGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
  const crossHost = isDifferentHost(fromUrl, toUrl);
  return {
    ...init,
    ...(mustSwitchToGet ? { method: "GET", body: undefined } : {}),
    ...(crossHost ? { headers: removeSensitiveHeaders(init.headers) } : {}),
  };
};

const pinnedTransport: SupplierOutboundTransport = async (target, init) => new Promise<SupplierOutboundResponse>((resolve, reject) => {
  const targetUrl = new URL(target.targetUrl);
  const selectedAddress = target.resolvedAddresses[0];
  const transport = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = headersToRecord(init.headers);
  const options: RequestOptions & { servername?: string } = {
    protocol: targetUrl.protocol,
    hostname: target.hostname,
    port: targetUrl.port || undefined,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: init.method || "GET",
    headers,
    servername: target.hostname,
    agent: false,
    lookup: createPinnedLookup(selectedAddress),
  };
  const request = transport(options, (response) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    response.on("data", (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > MAX_RESPONSE_BYTES) {
        request.destroy(new SupplierUrlValidationError("Supplier response exceeded the allowed size."));
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("end", () => {
      const bodyBuffer = Buffer.concat(chunks);
      const body = bodyBuffer.toString("utf8");
      const headersValue = responseHeaders(response.headers);
      resolve({
        status: response.statusCode || 0,
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        headers: headersValue,
        text: async () => body,
        arrayBuffer: async () => bodyBuffer.buffer.slice(
          bodyBuffer.byteOffset,
          bodyBuffer.byteOffset + bodyBuffer.byteLength,
        ) as ArrayBuffer,
        json: async <T>() => JSON.parse(body) as T,
      });
    });
  });
  request.once("error", reject);
  if (init.signal) {
    const abort = () => request.destroy(new DOMException("Aborted", "AbortError"));
    if (init.signal.aborted) abort();
    else init.signal.addEventListener("abort", abort, { once: true });
  }
  const body = init.body;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
  else if (body === undefined || body === null) request.end();
  else request.destroy(new SupplierUrlValidationError("Unsupported supplier request body."));
});

const logBlockedDestination = (policy: SupplierOutboundPolicy, target: string, error: unknown): void => {
  let hostname = "invalid";
  try {
    hostname = new URL(target).hostname.toLowerCase();
  } catch {
    // Keep the log free of a potentially credential-bearing input URL.
  }
  appLogger.warn("Supplier outbound request blocked.", {
    connector: policy.connector,
    sourceId: policy.sourceId || "unknown",
    hostname,
    reason: error instanceof Error ? error.message : "Unknown outbound policy failure",
  });
};

/**
 * Resolves, validates, and pins every connection to a validated public address.
 * Redirects are deliberately manual so each destination receives the same policy.
 */
export async function fetchSupplierOutbound(
  initialUrl: string,
  init: RequestInit,
  policy: SupplierOutboundPolicy,
  transport: SupplierOutboundTransport = pinnedTransport,
): Promise<SupplierOutboundResponse> {
  const maxRedirects = Math.min(Math.max(policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 0), DEFAULT_MAX_REDIRECTS);
  const resolver = policy.resolveHost || defaultSupplierHostResolver;
  let currentUrl = initialUrl;
  let currentInit: RequestInit = { ...init, redirect: "manual" };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let target: ValidatedSupplierTarget;
    try {
      target = await validateSupplierOutboundUrl(currentUrl, policy.approvedHosts, resolver);
    } catch (error) {
      logBlockedDestination(policy, currentUrl, error);
      throw error;
    }
    const response = await transport(target, currentInit);
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    if (redirectCount === maxRedirects) {
      throw new SupplierUrlValidationError("Supplier request exceeded the redirect limit.");
    }
    const nextUrl = new URL(location, target.targetUrl).toString();
    currentInit = redirectInit(currentInit, target.targetUrl, nextUrl, response.status);
    currentUrl = nextUrl;
  }
  throw new SupplierUrlValidationError("Supplier request exceeded the redirect limit.");
}
