import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { adminDb } from "../firebase";

export type HostResolver = (hostname: string) => Promise<string[]>;

export interface ValidatedSupplierTarget {
  targetUrl: string;
  hostname: string;
  resolvedAddresses: string[];
}

export class SupplierUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierUrlValidationError";
  }
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function parseApprovedHostsFromEnv(): string[] {
  return (process.env.ALLOWED_SUPPLIER_DOMAINS || "")
    .split(",")
    .map((host) => normalizeHost(host))
    .filter(Boolean);
}

function addApprovedHost(hosts: Set<string>, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") hosts.add(normalizeHost(parsed.hostname));
  } catch {
    // Supplier endpoint fields are often path fragments; ignore non-URL values.
  }
}

export async function getApprovedSupplierHosts(): Promise<string[]> {
  const hosts = new Set<string>(parseApprovedHostsFromEnv());
  const sourcesSnap = await adminDb.collection("supplierSources").get();
  sourcesSnap.forEach((document) => {
    const data = document.data();
    addApprovedHost(hosts, data.websiteUrl);
    addApprovedHost(hosts, data.endpoint);
    addApprovedHost(hosts, data.config?.targetUrl);
    addApprovedHost(hosts, data.config?.apiEndpoint);
  });
  return Array.from(hosts);
}

export function isApprovedSupplierHost(hostname: string, approvedHosts: string[]): boolean {
  const host = normalizeHost(hostname);
  return approvedHosts.some((approvedHost) => {
    const approved = normalizeHost(approvedHost);
    return host === approved || host.endsWith(`.${approved}`);
  });
}

export function isBlockedSupplierHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "metadata"
    || host === "instance-data"
    || host === "metadata.google.internal"
    || host.endsWith(".metadata.google.internal")
    || host === "metadata.azure.internal"
    || host === "metadata.aws.internal";
}

function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 // "this" network
    || a === 10 // RFC 1918
    || a === 127 // loopback
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link local and cloud metadata
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 0 && c === 0) // IETF protocol assignments
    || (a === 192 && b === 88 && c === 99) // deprecated 6to4 relay anycast
    || (a === 192 && b === 168) // RFC 1918
    || (a === 192 && b === 0 && c === 2) // TEST-NET-1
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224; // multicast, reserved, broadcast
}

function parseIpv6Groups(value: string): number[] | null {
  const normalized = value.toLowerCase().split("%")[0];
  const doubleColonIndex = normalized.indexOf("::");
  if (doubleColonIndex !== normalized.lastIndexOf("::")) return null;
  const expandPart = (part: string): string[] => part ? part.split(":") : [];
  const left = doubleColonIndex >= 0 ? expandPart(normalized.slice(0, doubleColonIndex)) : expandPart(normalized);
  const right = doubleColonIndex >= 0 ? expandPart(normalized.slice(doubleColonIndex + 2)) : [];
  const convertEmbeddedIpv4 = (parts: string[]): string[] | null => {
    const last = parts[parts.length - 1];
    if (!last?.includes(".")) return parts;
    if (isIP(last) !== 4) return null;
    const octets = last.split(".").map(Number);
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const convertedLeft = convertEmbeddedIpv4(left);
  const convertedRight = convertEmbeddedIpv4(right);
  if (!convertedLeft || !convertedRight) return null;
  const supplied = convertedLeft.length + convertedRight.length;
  if ((doubleColonIndex < 0 && supplied !== 8) || supplied > 8) return null;
  const groups = [
    ...convertedLeft,
    ...Array(Math.max(0, 8 - supplied)).fill("0"),
    ...convertedRight,
  ];
  const numbers = groups.map((group) => /^[0-9a-f]{1,4}$/u.test(group) ? Number.parseInt(group, 16) : Number.NaN);
  return numbers.some((group) => !Number.isInteger(group)) ? null : numbers;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = parseIpv6Groups(ip);
  if (!groups) return true;
  const isAllZero = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isMappedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const mappedIpv4 = isMappedIpv4
    ? `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    : "";
  return isAllZero
    || isLoopback
    || (groups[0] & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (groups[0] & 0xffc0) === 0xfe80 // link local fe80::/10
    || (groups[0] & 0xff00) === 0xff00 // multicast ff00::/8
    || (groups[0] === 0x2001 && groups[1] === 0x0db8) // documentation 2001:db8::/32
    || (groups[0] === 0x2001 && (groups[1] & 0xfff0) === 0x0010) // ORCHIDv2 2001:10::/28
    || (groups[0] === 0x2001 && groups[1] === 0x0002) // benchmarking 2001:2::/48
    || (isMappedIpv4 && isBlockedIpv4(mappedIpv4));
}

export function isBlockedSupplierIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

export const defaultSupplierHostResolver: HostResolver = async (hostname) => {
  const version = isIP(hostname);
  if (version) return [hostname];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
};

export function buildSupplierTargetUrl(websiteUrl: string, endpoint = ""): string {
  const baseUrl = new URL(websiteUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new SupplierUrlValidationError("Supplier URL must use http or https.");
  }
  const cleanEndpoint = endpoint.trim();
  return cleanEndpoint
    ? new URL(cleanEndpoint, baseUrl.toString().endsWith("/") ? baseUrl : `${baseUrl.toString()}/`).toString()
    : baseUrl.toString();
}

export async function validateSupplierOutboundUrl(
  target: string,
  approvedHosts: string[],
  resolveHost: HostResolver = defaultSupplierHostResolver,
): Promise<ValidatedSupplierTarget> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    throw new SupplierUrlValidationError("Invalid supplier URL.");
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new SupplierUrlValidationError("Supplier URL must use http or https.");
  }
  if (targetUrl.username || targetUrl.password) {
    throw new SupplierUrlValidationError("Supplier URL credentials are not allowed.");
  }
  const hostname = normalizeHost(targetUrl.hostname);
  if (isBlockedSupplierHostname(hostname)) throw new SupplierUrlValidationError("Supplier URL host is blocked.");
  if (!isApprovedSupplierHost(hostname, approvedHosts)) {
    throw new SupplierUrlValidationError("Supplier URL is not in the approved supplier domain allowlist.");
  }
  const resolvedAddresses = await resolveHost(hostname);
  if (resolvedAddresses.length === 0 || resolvedAddresses.some(isBlockedSupplierIp)) {
    throw new SupplierUrlValidationError("Supplier URL resolves to a blocked network address.");
  }
  return { targetUrl: targetUrl.toString(), hostname, resolvedAddresses: [...new Set(resolvedAddresses)] };
}

export async function validateSupplierRequestTarget(
  websiteUrl: string,
  endpoint: string,
  approvedHosts: string[],
  resolveHost: HostResolver = defaultSupplierHostResolver,
): Promise<ValidatedSupplierTarget> {
  let targetUrl: string;
  try {
    targetUrl = buildSupplierTargetUrl(websiteUrl, endpoint);
  } catch (error) {
    throw new SupplierUrlValidationError("Invalid supplier URL.");
  }
  return validateSupplierOutboundUrl(targetUrl, approvedHosts, resolveHost);
}
