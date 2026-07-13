import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveA2ZCredentials } from "../functions/src/api/suppliers/credentialSelection";
import { sanitizeA2ZResponseBody, sanitizeA2ZResponseHeaders } from "../functions/src/api/suppliers/a2z/diagnostics";
import {
  assertA2ZCredentialByteSafety,
  buildA2ZBrowserLoginBody,
  fingerprintA2ZCredentials,
} from "../functions/src/api/suppliers/a2z/credentialForensics";

test("A2Z Secret Manager credentials take precedence over stale Firestore credentials", () => {
  const resolved = resolveA2ZCredentials(
    { username: "secret-user", password: "secret-password" },
    [{ username: "legacy-user", password: "legacy-password", source: "firestore:a2z" }],
  );

  assert.deepEqual(resolved, {
    username: "secret-user",
    password: "secret-password",
    source: "secret-manager",
  });
});

test("A2Z legacy Firestore credentials are only a complete-pair fallback", () => {
  const fallback = resolveA2ZCredentials(
    { username: "", password: "" },
    [{ username: "legacy-user", password: "legacy-password", source: "firestore:a2z" }],
  );
  const incomplete = resolveA2ZCredentials(
    { username: "secret-user", password: "" },
    [{ username: "", password: "legacy-password", source: "firestore:a2z" }],
  );

  assert.equal(fallback?.source, "firestore:a2z");
  assert.equal(incomplete, null);
});

test("A2Z structured diagnostics redact cookies and bound response bodies", () => {
  const headers = new Headers({
    "content-type": "application/json",
    "set-cookie": "ci_session=top-secret; Path=/; HttpOnly",
  });
  const sanitizedHeaders = sanitizeA2ZResponseHeaders(headers);

  assert.equal(sanitizedHeaders["content-type"], "application/json");
  assert.equal(sanitizedHeaders["set-cookie"], "[redacted; cookie-names=ci_session]");
  assert.equal(JSON.stringify(sanitizedHeaders).includes("top-secret"), false);
  assert.equal(sanitizeA2ZResponseBody(`line 1\n${"x".repeat(600)}`).length, 500);
});

test("A2Z connector preserves the current form-session authentication contract", () => {
  const connector = readFileSync("functions/src/api/suppliers/a2z/A2ZConnectorService.ts", "utf8");

  assert.match(connector, /`\$\{baseDomain\}\/dash`/);
  assert.match(connector, /\/Login\/auth/);
  assert.match(connector, /buildA2ZBrowserLoginBody\(username, password\)/);
  assert.match(connector, /application\/x-www-form-urlencoded; charset=UTF-8/);
  assert.match(connector, /"Cookie": cleanPreCookie/);
  assert.match(connector, /"Origin": baseDomain/);
  assert.match(connector, /"Referer": `\$\{baseDomain\}\/dash`/);
  assert.match(connector, /"X-Requested-With": "XMLHttpRequest"/);
  assert.match(connector, /application\/json, text\/javascript/);
  assert.match(connector, /"User-Agent": this\.BROWSER_USER_AGENT/);
  assert.match(connector, /\/Product\/getAllproducts2/);
  assert.doesNotMatch(connector, /Pre-authentication cookies acquired/);
});

test("A2Z credential bytes remain exact and use browser jQuery form serialization", () => {
  const username = "User !'()~* සිංහල";
  const password = "P@ss !'()~* 密碼";
  const body = buildA2ZBrowserLoginBody(username, password);

  assert.equal(
    body,
    `un=${encodeURIComponent(username).replace(/%20/g, "+")}&pw=${encodeURIComponent(password).replace(/%20/g, "+")}`,
  );
  assert.equal(new URLSearchParams(body).get("un"), username);
  assert.equal(new URLSearchParams(body).get("pw"), password);
});

test("A2Z credential diagnostics fingerprint exact UTF-8 bytes without plaintext", () => {
  const fingerprint = fingerprintA2ZCredentials("üser", "päss");

  assert.deepEqual(Object.keys(fingerprint).sort(), [
    "passwordLength",
    "passwordSha256",
    "usernameLength",
    "usernameSha256",
  ]);
  assert.equal(fingerprint.usernameLength, Buffer.byteLength("üser", "utf8"));
  assert.equal(fingerprint.passwordLength, Buffer.byteLength("päss", "utf8"));
  assert.equal(JSON.stringify(fingerprint).includes("üser"), false);
  assert.equal(JSON.stringify(fingerprint).includes("päss"), false);
});

test("A2Z credentials reject BOM, CRLF, newlines, and boundary whitespace without normalization", () => {
  assert.doesNotThrow(() => assertA2ZCredentialByteSafety("exact-user", "exact-password"));
  assert.throws(() => assertA2ZCredentialByteSafety(" user", "password"), /boundary or control bytes/);
  assert.throws(() => assertA2ZCredentialByteSafety("user", "password "), /boundary or control bytes/);
  assert.throws(() => assertA2ZCredentialByteSafety("\uFEFFuser", "password"), /boundary or control bytes/);
  assert.throws(() => assertA2ZCredentialByteSafety("user\r\n", "password"), /boundary or control bytes/);
  assert.throws(() => assertA2ZCredentialByteSafety("user", "pass\nword"), /boundary or control bytes/);
});

test("A2Z deployment cannot package the legacy bootstrap endpoint or stale Functions output", () => {
  const auditedFiles = [
    "functions/src/api/suppliers/a2z/A2ZConnectorService.ts",
    "src/services/connectors/a2z-website/A2ZConnectorService.ts",
    "server.ts",
  ];

  for (const file of auditedFiles) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\/dash\/Account\/Login/);
  }

  const firebaseConfig = JSON.parse(readFileSync("firebase.json", "utf8"));
  const functionsConfig = Array.isArray(firebaseConfig.functions)
    ? firebaseConfig.functions[0]
    : firebaseConfig.functions;

  assert.deepEqual(functionsConfig.predeploy, [
    "npm --prefix \"$RESOURCE_DIR\" run build",
  ]);
});
