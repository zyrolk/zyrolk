import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isProtectedSupplierAccount,
  normalizeSupplierProfileStatus,
  supplierPromotionProfileStatus,
} from "../functions/src/api/suppliers/supplierAccountAdministration";

test("supplier account promotion preserves only legitimate profile states and otherwise starts pending", () => {
  assert.equal(supplierPromotionProfileStatus(undefined), "pending");
  assert.equal(supplierPromotionProfileStatus("corrupt"), "pending");
  assert.equal(supplierPromotionProfileStatus(" PENDING "), "pending");
  assert.equal(supplierPromotionProfileStatus("active"), "active");
  assert.equal(supplierPromotionProfileStatus("disabled"), "disabled");
  assert.equal(normalizeSupplierProfileStatus("suspended"), null);
});

test("supplier account administration protects every trusted administrator identity", () => {
  const user = (customClaims: Record<string, unknown>) => ({ customClaims }) as never;
  assert.equal(isProtectedSupplierAccount(user({}), "customer"), false);
  assert.equal(isProtectedSupplierAccount(user({ admin: true }), "customer"), true);
  assert.equal(isProtectedSupplierAccount(user({ supplierHubAdmin: true }), "customer"), true);
  assert.equal(isProtectedSupplierAccount(user({ supplierHubSuperAdmin: true }), "customer"), true);
  assert.equal(isProtectedSupplierAccount(user({ role: "owner" }), "customer"), true);
  assert.equal(isProtectedSupplierAccount(user({}), "admin"), true);
});

test("supplier onboarding endpoints use the existing custom-claim boundary and server-only audit path", () => {
  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  const administration = readFileSync("functions/src/api/suppliers/supplierAccountAdministration.ts", "utf8");
  const rules = readFileSync("firestore.rules", "utf8");
  const portal = readFileSync("functions/src/api/routes/supplierPortal.ts", "utf8");

  for (const endpoint of [
    '/api/supplier-accounts/lookup", requireSupplierHubAdmin',
    '/api/supplier-accounts/:uid/promote", requireSupplierHubAdmin',
    '/api/supplier-accounts/:uid/activate", requireSupplierHubAdmin',
    '/api/supplier-accounts/:uid/disable", requireSupplierHubAdmin',
  ]) assert.match(routes, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(administration, /collection\("supplier_operations_audit"\)/u);
  assert.match(administration, /transaction\.create\(auditReference/u);
  assert.match(rules, /match \/supplier_profiles\/\{supplierId\}[\s\S]*allow write: if false;/u);
  assert.match(rules, /match \/supplier_operations_audit\/\{docId\}[\s\S]*allow create, update, delete: if false;/u);
  assert.match(portal, /if \(identity\.profileStatus === "disabled"\) throw new ApiError\("Supplier profile is disabled", 403\)/u);
});

test("the existing Google sign-in flow preserves a server-managed supplier role", () => {
  const authModal = readFileSync("src/components/AuthModal.tsx", "utf8");
  assert.match(authModal, /const existingProfile = await getDoc\(userReference\)/u);
  assert.match(authModal, /existingProfile\.exists\(\) \? \{\} : \{ role: 'customer'/u);
});

test("Supplier Management exposes only the requested account lookup and lifecycle controls", () => {
  const dashboard = readFileSync("src/components/supplier-management/SupplierManagementDashboard.tsx", "utf8");
  for (const label of ["Firebase Auth email or UID", "Promote to supplier", "Approve / Activate", "Disable supplier", "Profile:"]) {
    assert.match(dashboard, new RegExp(label.replace("/", "\\/")));
  }
  assert.match(dashboard, /protectedAccount/u);
  assert.match(dashboard, /authDisabled/u);
});
