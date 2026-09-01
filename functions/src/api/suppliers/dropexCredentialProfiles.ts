export const DROPEX_RECOMMENDED_CREDENTIAL_PROFILE = "dropex-production";
export const DROPEX_CREDENTIAL_PROFILE_MAP_PREFIX = "dropex-profiles-v1:";

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_PROFILE_COUNT = 100;
const MAX_SECRET_VALUE_LENGTH = 8_192;

export const DROPEX_DEFAULT_API_HOSTS = [
  "userservicev2.dreamworld.lk",
  "inventoryservice.dreamworld.lk",
] as const;

interface ProfileSecretEntry {
  value: string;
  allowedHosts: string[];
}

type ParsedProfileSecret =
  | { kind: "legacy"; value: string }
  | { kind: "profiles"; profiles: Map<string, ProfileSecretEntry> };

export interface DropexRuntimeSecretValues {
  username: string;
  password: string;
}

export interface DropexCredentialProfileResolution {
  username: string;
  password: string;
  profileId: string;
}

export class DropexCredentialProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropexCredentialProfileError";
  }
}

const normalizeHostname = (value: unknown): string => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/^\[|\]$/gu, "")
  .replace(/\.$/u, "");

const cleanAllowedHosts = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  const hosts = value.map(normalizeHostname);
  if (hosts.some((host) => !HOST_PATTERN.test(host))) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  return [...new Set(hosts)].sort((left, right) => left.localeCompare(right));
};

const parseProfileEntry = (value: unknown): ProfileSecretEntry => {
  if (typeof value === "string") {
    const secretValue = value;
    if (!secretValue || secretValue.length > MAX_SECRET_VALUE_LENGTH) {
      throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
    }
    return { value: secretValue, allowedHosts: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  const record = value as Record<string, unknown>;
  const secretValue = typeof record.value === "string" ? record.value : "";
  if (!secretValue || secretValue.length > MAX_SECRET_VALUE_LENGTH) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  return { value: secretValue, allowedHosts: cleanAllowedHosts(record.allowedHosts) };
};

const parseRuntimeSecret = (value: unknown): ParsedProfileSecret => {
  const secretValue = typeof value === "string" ? value : "";
  if (!secretValue) return { kind: "legacy", value: "" };
  if (!secretValue.startsWith(DROPEX_CREDENTIAL_PROFILE_MAP_PREFIX)) {
    return { kind: "legacy", value: secretValue };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretValue.slice(DROPEX_CREDENTIAL_PROFILE_MAP_PREFIX.length));
  } catch {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_PROFILE_COUNT) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
  }
  const profiles = new Map<string, ProfileSecretEntry>();
  for (const [profileId, entry] of entries) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new DropexCredentialProfileError("Dropex credential profile configuration is invalid.");
    }
    profiles.set(profileId, parseProfileEntry(entry));
  }
  return { kind: "profiles", profiles };
};

export function normalizeDropexCredentialReference(value: unknown): string {
  const reference = String(value || "").trim();
  if (!reference) {
    throw new DropexCredentialProfileError("Dropex credential profile reference is required.");
  }
  if (!PROFILE_ID_PATTERN.test(reference)) {
    throw new DropexCredentialProfileError("Dropex credential profile reference is not allowed.");
  }
  return reference;
}

const assertHostAllowed = (targetUrl: string, allowedHosts: readonly string[]): void => {
  let hostname = "";
  try {
    const target = new URL(targetUrl);
    if (target.protocol !== "https:") {
      throw new DropexCredentialProfileError("Dropex credential targets must use HTTPS.");
    }
    hostname = normalizeHostname(target.hostname);
  } catch (error) {
    if (error instanceof DropexCredentialProfileError) throw error;
    throw new DropexCredentialProfileError("Dropex credential target is invalid.");
  }
  if (!allowedHosts.some((allowedHost) => hostname === normalizeHostname(allowedHost))) {
    throw new DropexCredentialProfileError("Dropex credential profile is not authorized for this supplier host.");
  }
};

export function resolveDropexCredentialProfile(
  runtimeSecrets: DropexRuntimeSecretValues,
  credentialReference: unknown,
  targetUrl: string,
): DropexCredentialProfileResolution {
  const profileId = normalizeDropexCredentialReference(credentialReference);
  const usernames = parseRuntimeSecret(runtimeSecrets.username);
  const passwords = parseRuntimeSecret(runtimeSecrets.password);

  if (usernames.kind !== passwords.kind) {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is incomplete.");
  }

  if (usernames.kind === "legacy" && passwords.kind === "legacy") {
    throw new DropexCredentialProfileError("Dropex credential profile is not configured in Firebase Secret Manager.");
  }

  if (usernames.kind !== "profiles" || passwords.kind !== "profiles") {
    throw new DropexCredentialProfileError("Dropex credential profile configuration is incomplete.");
  }
  const username = usernames.profiles.get(profileId);
  const password = passwords.profiles.get(profileId);
  if (!username || !password) {
    throw new DropexCredentialProfileError("Dropex credential profile is not configured in Firebase Secret Manager.");
  }
  const usernameHosts = username.allowedHosts;
  const passwordHosts = password.allowedHosts;
  const allowedHosts = usernameHosts.length > 0 ? usernameHosts : passwordHosts;
  if (usernameHosts.length > 0 && passwordHosts.length > 0
    && (usernameHosts.length !== passwordHosts.length || usernameHosts.some((host, index) => host !== passwordHosts[index]))) {
    throw new DropexCredentialProfileError("Dropex credential profile host configuration is inconsistent.");
  }
  if (allowedHosts.length === 0) {
    throw new DropexCredentialProfileError("Dropex credential profile has no authorized supplier host.");
  }
  assertHostAllowed(targetUrl, allowedHosts);
  return { username: username.value, password: password.value, profileId };
}
