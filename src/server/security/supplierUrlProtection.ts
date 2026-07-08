import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type HostResolver = (hostname: string) => Promise<string[]>;

export interface ValidatedSupplierTarget {
  targetUrl: string;
  hostname: string;
}

class SupplierUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierUrlValidationError";
  }
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function parseApprovedHostsFromEnv(): string[] {
  const raw = process.env.ALLOWED_SUPPLIER_DOMAINS || "";
  return raw
    .split(",")
    .map((host) => normalizeHost(host))
    .filter(Boolean);
}

function addApprovedHost(hosts: Set<string>, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      hosts.add(normalizeHost(parsed.hostname));
    }
  } catch {
    // Supplier endpoint fields can be relative path fragments.
  }
}

export async function getApprovedSupplierHosts(adminDb: any): Promise<string[]> {
  const hosts = new Set<string>(parseApprovedHostsFromEnv());
  const sourcesSnap = await adminDb.collection("supplierSources").get();

  sourcesSnap.forEach((doc: any) => {
    const data = doc.data();
    addApprovedHost(hosts, data.websiteUrl);
    addApprovedHost(hosts, data.endpoint);
    addApprovedHost(hosts, data.config?.targetUrl);
    addApprovedHost(hosts, data.config?.apiEndpoint);
  });

  return Array.from(hosts);
}

function isApprovedHost(hostname: string, approvedHosts: string[]): boolean {
  const host = normalizeHost(hostname);
  return approvedHosts.some((approvedHost) => {
    const approved = normalizeHost(approvedHost);
    return host === approved || host.endsWith(`.${approved}`);
  });
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal";
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c, d] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 169 && b === 254 && c === 169 && d === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIPv4(ip);
  }
  if (version === 6) {
    return isPrivateIPv6(ip);
  }
  return true;
}

const defaultResolveHost: HostResolver = async (hostname) => {
  if (isIP(hostname)) {
    return [hostname];
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
};

export function buildSupplierTargetUrl(websiteUrl: string, endpoint = ""): string {
  const baseUrl = new URL(websiteUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new SupplierUrlValidationError("Supplier URL must use http or https.");
  }

  const cleanEndpoint = endpoint.trim();
  if (!cleanEndpoint) {
    return baseUrl.toString();
  }

  return new URL(cleanEndpoint, baseUrl.toString().endsWith("/") ? baseUrl : `${baseUrl.toString()}/`).toString();
}

export async function validateSupplierRequestTarget(
  websiteUrl: string,
  endpoint: string,
  approvedHosts: string[],
  resolveHost: HostResolver = defaultResolveHost
): Promise<ValidatedSupplierTarget> {
  let targetUrl: URL;

  try {
    targetUrl = new URL(buildSupplierTargetUrl(websiteUrl, endpoint));
  } catch {
    throw new SupplierUrlValidationError("Invalid supplier URL.");
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new SupplierUrlValidationError("Supplier URL must use http or https.");
  }

  const hostname = normalizeHost(targetUrl.hostname);
  if (isBlockedHostname(hostname)) {
    throw new SupplierUrlValidationError("Supplier URL host is blocked.");
  }

  if (!isApprovedHost(hostname, approvedHosts)) {
    throw new SupplierUrlValidationError("Supplier URL is not in the approved supplier domain allowlist.");
  }

  const resolvedAddresses = await resolveHost(hostname);
  if (resolvedAddresses.length === 0 || resolvedAddresses.some(isBlockedIp)) {
    throw new SupplierUrlValidationError("Supplier URL resolves to a blocked network address.");
  }

  return {
    targetUrl: targetUrl.toString(),
    hostname
  };
}
