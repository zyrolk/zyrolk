import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hasAdminAccess } from "../functions/src/api/middleware/adminAuth";
import { validateSupplierRequestTarget } from "../functions/src/api/security/supplierUrlProtection";

test("admin decisions require a trusted Firebase custom claim", () => {
  assert.equal(hasAdminAccess({ admin: true }), true);
  assert.equal(hasAdminAccess({ role: "admin" }), true);
  assert.equal(hasAdminAccess({ email: "zyrolkofficial@gmail.com" }), false);
  assert.equal(hasAdminAccess({ role: "customer" }), false);
});

test("SSRF protection blocks localhost and private IPs", async () => {
  await assert.rejects(
    () => validateSupplierRequestTarget("https://localhost", "", ["localhost"], async () => ["127.0.0.1"]),
    /blocked/,
  );

  await assert.rejects(
    () => validateSupplierRequestTarget("https://supplier.example.com", "", ["supplier.example.com"], async () => ["10.0.0.5"]),
    /blocked network address/,
  );
});

test("SSRF protection rejects invalid protocols", async () => {
  await assert.rejects(
    () => validateSupplierRequestTarget("file:///etc/passwd", "", ["example.com"], async () => ["93.184.216.34"]),
    /Invalid supplier URL/,
  );
});

test("allowlisted supplier URLs succeed with public DNS resolution", async () => {
  const target = await validateSupplierRequestTarget(
    "https://supplier.example.com",
    "/api/products",
    ["supplier.example.com"],
    async () => ["93.184.216.34"],
  );

  assert.equal(target.hostname, "supplier.example.com");
  assert.equal(target.targetUrl, "https://supplier.example.com/api/products");
});

test("Firestore rules reserve order writes for trusted backend code", () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const orderRules = rules.slice(rules.indexOf('match /orders/{orderId}'), rules.indexOf('match /contact_inquiries'));
  assert.match(orderRules, /allow create, update, delete: if false/);
  assert.doesNotMatch(orderRules, /customerUid == 'guest'/);
});

test("admin rules use trusted Firebase custom claims rather than email identity", () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const adminHelper = rules.slice(rules.indexOf('function isAdmin'), rules.indexOf('function isOwner'));
  assert.match(adminHelper, /request\.auth\.token\.admin == true/);
  assert.match(adminHelper, /request\.auth\.token\.role == 'admin'/);
  assert.doesNotMatch(adminHelper, /zyrolkofficial@gmail\.com/);
});
