export const A2Z_GLOBAL_CREDENTIAL_PROFILE = "a2z-global";
export const A2Z_GLOBAL_CREDENTIAL_REFERENCES = new Set([
  A2Z_GLOBAL_CREDENTIAL_PROFILE,
  "firebase-functions:a2z-global",
  "firebase-secret-manager:A2Z_USERNAME+A2Z_PASSWORD",
  // These identifiers were stored by earlier Supplier Hub releases while
  // every A2Z source still resolved the same globally bound secret pair.
  "A2Z_A2Z_MAIN",
  "A2Z_REFERENCED_SUPPLIER",
]);
export const A2Z_CREDENTIAL_PROFILE_MAP_PREFIX = "a2z-profiles-v1:";

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_PROFILE_COUNT = 100;
const MAX_SECRET_VALUE_LENGTH = 8_192;
const DEFAULT_LEGACY_A2Z_HOSTS = ["a2zdropshipping.lk", "www.a2zdropshipping.lk"];

interface ProfileSecretEntry {
  value: string;
  allowedHosts: string[];
}

type ParsedProfileSecret =
  | { kind: "legacy"; value: string }
  | { kind: "profiles"; profiles: Map<string, ProfileSecretEntry> };

export interface A2ZRuntimeSecretValues {
  username: string;
  password: string;
}

export interface A2ZCredentialProfileResolution {
  username: string;
  password: string;
  profileId: string;
}

export class A2ZCredentialProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2ZCredentialProfileError";
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
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  const hosts = value.map(normalizeHostname);
  if (hosts.some((host) => !HOST_PATTERN.test(host))) {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  return [...new Set(hosts)].sort((left, right) => left.localeCompare(right));
};

const parseProfileEntry = (value: unknown): ProfileSecretEntry => {
  if (typeof value === "string") {
    const secretValue = value;
    if (!secretValue || secretValue.length > MAX_SECRET_VALUE_LENGTH) {
      throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
    }
    return { value: secretValue, allowedHosts: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  const record = value as Record<string, unknown>;
  const secretValue = typeof record.value === "string" ? record.value : "";
  if (!secretValue || secretValue.length > MAX_SECRET_VALUE_LENGTH) {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  return { value: secretValue, allowedHosts: cleanAllowedHosts(record.allowedHosts) };
};

const parseRuntimeSecret = (value: unknown): ParsedProfileSecret => {
  const secretValue = typeof value === "string" ? value : "";
  if (!secretValue) return { kind: "legacy", value: "" };
  if (!secretValue.startsWith(A2Z_CREDENTIAL_PROFILE_MAP_PREFIX)) {
    return { kind: "legacy", value: secretValue };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretValue.slice(A2Z_CREDENTIAL_PROFILE_MAP_PREFIX.length));
  } catch {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_PROFILE_COUNT) {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
  }
  const profiles = new Map<string, ProfileSecretEntry>();
  for (const [profileId, entry] of entries) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new A2ZCredentialProfileError("A2Z credential profile configuration is invalid.");
    }
    profiles.set(profileId, parseProfileEntry(entry));
  }
  return { kind: "profiles", profiles };
};

export function normalizeA2ZCredentialReference(value: unknown): string {
  const reference = String(value || "").trim();
  const configuredLegacyReferences = String(process.env.A2Z_LEGACY_CREDENTIAL_REFERENCES || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => PROFILE_ID_PATTERN.test(entry));
  if (
    !reference
    || A2Z_GLOBAL_CREDENTIAL_REFERENCES.has(reference)
    || configuredLegacyReferences.includes(reference)
  ) return A2Z_GLOBAL_CREDENTIAL_PROFILE;
  if (!PROFILE_ID_PATTERN.test(reference)) {
    throw new A2ZCredentialProfileError("A2Z credential profile reference is not allowed.");
  }
  return reference;
}

export function isA2ZGlobalCredentialReference(value: unknown): boolean {
  try {
    return normalizeA2ZCredentialReference(value) === A2Z_GLOBAL_CREDENTIAL_PROFILE;
  } catch {
    return false;
  }
}

export function configuredLegacyA2ZCredentialHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = String(env.A2Z_LEGACY_CREDENTIAL_HOSTS || "")
    .split(",")
    .map(normalizeHostname)
    .filter((host) => HOST_PATTERN.test(host));
  return configured.length > 0 ? [...new Set(configured)] : [...DEFAULT_LEGACY_A2Z_HOSTS];
}

const assertHostAllowed = (targetUrl: string, allowedHosts: readonly string[]): void => {
  let hostname = "";
  try {
    const target = new URL(targetUrl);
    if (target.protocol !== "https:") {
      throw new A2ZCredentialProfileError("A2Z credential targets must use HTTPS.");
    }
    hostname = normalizeHostname(target.hostname);
  } catch (error) {
    if (error instanceof A2ZCredentialProfileError) throw error;
    throw new A2ZCredentialProfileError("A2Z credential target is invalid.");
  }
  if (!allowedHosts.includes(hostname)) {
    throw new A2ZCredentialProfileError("A2Z credential profile is not authorized for this supplier host.");
  }
};

export function resolveA2ZCredentialProfile(
  runtimeSecrets: A2ZRuntimeSecretValues,
  credentialReference: unknown,
  targetUrl: string,
  legacyAllowedHosts: readonly string[] = configuredLegacyA2ZCredentialHosts(),
): A2ZCredentialProfileResolution {
  const profileId = normalizeA2ZCredentialReference(credentialReference);
  const usernames = parseRuntimeSecret(runtimeSecrets.username);
  const passwords = parseRuntimeSecret(runtimeSecrets.password);

  if (usernames.kind !== passwords.kind) {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is incomplete.");
  }

  if (usernames.kind === "legacy" && passwords.kind === "legacy") {
    if (profileId !== A2Z_GLOBAL_CREDENTIAL_PROFILE || !usernames.value || !passwords.value) {
      throw new A2ZCredentialProfileError("A2Z credential profile is not configured in Firebase Secret Manager.");
    }
    assertHostAllowed(targetUrl, legacyAllowedHosts.map(normalizeHostname));
    return { username: usernames.value, password: passwords.value, profileId };
  }

  if (usernames.kind !== "profiles" || passwords.kind !== "profiles") {
    throw new A2ZCredentialProfileError("A2Z credential profile configuration is incomplete.");
  }
  const username = usernames.profiles.get(profileId);
  const password = passwords.profiles.get(profileId);
  if (!username || !password) {
    throw new A2ZCredentialProfileError("A2Z credential profile is not configured in Firebase Secret Manager.");
  }
  const usernameHosts = username.allowedHosts;
  const passwordHosts = password.allowedHosts;
  const allowedHosts = usernameHosts.length > 0 ? usernameHosts : passwordHosts;
  if (usernameHosts.length > 0 && passwordHosts.length > 0
    && (usernameHosts.length !== passwordHosts.length || usernameHosts.some((host, index) => host !== passwordHosts[index]))) {
    throw new A2ZCredentialProfileError("A2Z credential profile host configuration is inconsistent.");
  }
  if (allowedHosts.length === 0) {
    throw new A2ZCredentialProfileError("A2Z credential profile has no authorized supplier host.");
  }
  assertHostAllowed(targetUrl, allowedHosts);
  return { username: username.value, password: password.value, profileId };
}
