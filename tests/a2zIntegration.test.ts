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
import {
  extractA2ZProductImages,
  ProductParser as FunctionsProductParser,
} from "../functions/src/api/suppliers/a2z/ProductParser";
import { extractA2ZProductImages as extractBrowserA2ZProductImages } from "../src/services/connectors/a2z-website/productImages";

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

test("A2Z product images map supplier fields and normalize relative URLs", () => {
  const raw = {
    pro_img: "/uploads/products/watch.jpg",
    images: [
      { url: "https://cdn.example.com/watch-2.jpg" },
      "/uploads/products/watch.jpg",
    ],
    image_url: "//cdn.example.com/watch-3.jpg",
  };

  assert.deepEqual(extractA2ZProductImages(raw, "https://a2zdropshipping.lk/dash"), [
    "https://cdn.example.com/watch-2.jpg",
    "https://a2zdropshipping.lk/uploads/products/watch.jpg",
    "https://cdn.example.com/watch-3.jpg",
  ]);
});

test("A2Z Functions and browser image helpers keep mapping consistent", () => {
  const raw = {
    pro_code: "A2Z-100",
    pro_name: "Supplier Watch",
    pro_image: "products/watch.jpg",
    wholesale_price: 1000,
    website_price: 1500,
    bal: 4,
  };

  const functionsProduct = FunctionsProductParser.parseJsonPayload(raw, "https://a2zdropshipping.lk");
  const browserImages = extractBrowserA2ZProductImages(raw, "https://a2zdropshipping.lk");

  assert.deepEqual(functionsProduct.mediaGallery, ["https://a2zdropshipping.lk/products/watch.jpg"]);
  assert.deepEqual(browserImages, functionsProduct.mediaGallery);
});

test("A2Z image extraction tolerates supplier image-field renames", () => {
  const raw = {
    product_pic: "uploads/products/camera.jpg",
    thumbnail_path: "/uploads/products/camera-thumb.jpg",
  };

  const expected = [
    "https://a2zdropshipping.lk/uploads/products/camera.jpg",
    "https://a2zdropshipping.lk/uploads/products/camera-thumb.jpg",
  ];

  assert.deepEqual(extractA2ZProductImages(raw, "https://a2zdropshipping.lk"), expected);
  assert.deepEqual(extractBrowserA2ZProductImages(raw, "https://a2zdropshipping.lk"), expected);
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

test("A2Z credential resolution emits redacted forensics for every connection test", () => {
  const credentials = readFileSync("functions/src/api/suppliers/credentials.ts", "utf8");
  const connector = readFileSync("functions/src/api/suppliers/a2z/A2ZSupplierConnector.ts", "utf8");

  assert.match(credentials, /fingerprintA2ZCredentials\(credentials\.username, credentials\.password\)/);
  assert.match(credentials, /event: "a2z_credentials_resolved"/);
  assert.match(credentials, /\.\.\.credentialForensics/);

  const fetchProductsBody = connector.match(
    /public async fetchProducts\(\): Promise<SupplierFetchResult> \{([\s\S]*?)\n  \}/,
  )?.[1] || "";
  const testConnectionBody = connector.match(
    /public async testConnection\(\): Promise<SupplierConnectionTestResult> \{([\s\S]*?)\n  \}/,
  )?.[1] || "";

  assert.match(testConnectionBody, /await this\.fetchProducts\(\)/);
  assert.match(fetchProductsBody, /await getA2ZCredentials\(\)/);
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
