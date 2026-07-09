import assert from "node:assert/strict";
import test from "node:test";
import { hasSupplierAdminAccess } from "../functions/src/api/middleware/adminAuth";
import { validateSupplierRequestTarget } from "../functions/src/api/security/supplierUrlProtection";

test("supplier endpoint admin decision requires admin email or admin role", () => {
  assert.equal(hasSupplierAdminAccess("zyrolkofficial@gmail.com", null), true);
  assert.equal(hasSupplierAdminAccess("manager@example.com", "admin"), true);
  assert.equal(hasSupplierAdminAccess("customer@example.com", "customer"), false);
  assert.equal(hasSupplierAdminAccess(undefined, undefined), false);
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
