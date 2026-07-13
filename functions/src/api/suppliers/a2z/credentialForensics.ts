import { createHash } from "node:crypto";

export interface A2ZCredentialFingerprint {
  usernameLength: number;
  passwordLength: number;
  usernameSha256: string;
  passwordSha256: string;
}

function toUtf8(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(toUtf8(value)).digest("hex");
}

function hasForbiddenCredentialBytes(value: string): boolean {
  return /[\r\n\uFEFF]/u.test(value) || /^\s|\s$/u.test(value);
}

export function assertA2ZCredentialByteSafety(username: string, password: string): void {
  if (hasForbiddenCredentialBytes(username) || hasForbiddenCredentialBytes(password)) {
    throw new Error("A2Z credentials contain unsupported boundary or control bytes.");
  }
}

export function fingerprintA2ZCredentials(username: string, password: string): A2ZCredentialFingerprint {
  const usernameBytes = toUtf8(username);
  const passwordBytes = toUtf8(password);

  return {
    usernameLength: usernameBytes.length,
    passwordLength: passwordBytes.length,
    usernameSha256: sha256(username),
    passwordSha256: sha256(password),
  };
}

function encodeJQueryFormComponent(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

export function buildA2ZBrowserLoginBody(username: string, password: string): string {
  return `un=${encodeJQueryFormComponent(username)}&pw=${encodeJQueryFormComponent(password)}`;
}
