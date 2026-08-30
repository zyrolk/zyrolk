import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAdminProductDraft,
} from "../functions/src/api/products/adminProductManagement";
import {
  buildZyroProductId,
  buildZyroSkuCandidates,
} from "../functions/src/api/suppliers/supplierProductIdentity";
import { validateProductForSave } from "../src/services/products/productValidation";

const validDraft = () => ({
  name: "Manual Test Product",
  description: "A valid manually managed product.",
  price: 1250,
  originalPrice: 1500,
  imageUrl: "https://cdn.example.test/product.jpg",
  imageUrls: ["https://cdn.example.test/product.jpg"],
  category: "electronics",
  subcategory: "phones",
  brand: "test-brand",
  model: "TEST-1",
  barcode: "1234567890123",
  stock: 5,
  specs: { Model: "TEST-1" },
  isActive: true,
});

test("SH-4A manual product identity is opaque, stable per request, and uses the shared SKU namespace", () => {
  const first = buildZyroProductId({ manualRequestId: "admin-1|request-00000001" });
  const retry = buildZyroProductId({ manualRequestId: "admin-1|request-00000001" });
  const second = buildZyroProductId({ manualRequestId: "admin-1|request-00000002" });
  assert.equal(first, retry);
  assert.notEqual(first, second);
  assert.match(first, /^zyro-[a-f0-9]{32}$/u);
  assert.equal(buildZyroSkuCandidates(first).length, 8);
});

test("SH-4A server validation allowlists manual product fields and rejects injected authority", () => {
  const parsed = parseAdminProductDraft(validDraft());
  assert.equal(parsed.name, "Manual Test Product");
  assert.equal(parsed.price, 1250);
  assert.throws(
    () => parseAdminProductDraft({ ...validDraft(), zyroSkuClaimId: "browser-claim" }),
    /Unsupported product field/u,
  );
  assert.throws(
    () => parseAdminProductDraft({ ...validDraft(), barcode: "invalid" }),
    /Barcode must contain 8 to 14 digits/u,
  );
  assert.throws(
    () => parseAdminProductDraft({ ...validDraft(), price: -1 }),
    /Sale price is invalid/u,
  );
});

test("SH-4A browser validation permits missing identity only for a new server-assigned product", () => {
  const product = validDraft();
  const common = {
    product,
    products: [],
    categories: [{ id: "electronics", name: "Electronics", icon: "Package", subcategories: [{ id: "phones", name: "Phones" }] }],
    brands: [{ id: "test-brand", name: "Test Brand" }],
  };
  assert.ok(validateProductForSave(common).some((error) => /Product slug|SKU/u.test(error)));
  assert.equal(validateProductForSave({ ...common, serverAssignedIdentity: true }).length, 0);
});

test("SH-4A Admin UI uses authenticated API operations and contains no browser SKU allocation or product writes", () => {
  const dashboard = readFileSync("src/components/AdminDashboard.tsx", "utf8");
  const clientApi = readFileSync("src/services/admin/adminProductApi.ts", "utf8");
  const routes = readFileSync("functions/src/api/routes/adminProducts.ts", "utf8");
  const app = readFileSync("functions/src/api/app.ts", "utf8");

  assert.doesNotMatch(dashboard, /generateNextSku|generateUniqueSlug/u);
  assert.doesNotMatch(dashboard, /(?:setDoc|updateDoc|deleteDoc)\(doc\(db, ["']products["']/u);
  assert.match(dashboard, /createAdminProduct\(/u);
  assert.match(dashboard, /updateAdminProduct\(/u);
  assert.match(dashboard, /archiveAdminProduct\(/u);
  assert.match(clientApi, /Authorization: `Bearer \$\{token\}`/u);
  assert.match(clientApi, /getAppCheckRequestHeaders/u);
  assert.match(clientApi, /Idempotency-Key/u);
  assert.match(routes, /app\.post\("\/api\/admin\/products", requireAdminAuth/u);
  assert.match(routes, /app\.patch\("\/api\/admin\/products\/:productId", requireAdminAuth/u);
  assert.match(app, /adminAppCheck\.verifyToken/u);
});

test("SH-4A Firestore Rules keep product identity and audit mutations server-only", () => {
  const rules = readFileSync("firestore.rules", "utf8");
  assert.match(rules, /match \/products\/\{productId\}[\s\S]*allow read: if isAdmin\(\) \|\| isPublicProductData\(resource\.data\);[\s\S]*allow create, update, delete: if false;/u);
  assert.match(rules, /match \/product_private\/\{productId\}[\s\S]*allow read: if isAdmin\(\);[\s\S]*allow create, update, delete: if false;/u);
  assert.match(rules, /match \/zyro_sku_claims\/\{claimId\}[\s\S]*allow read: if false;[\s\S]*allow create, update, delete: if false;/u);
  assert.match(rules, /match \/admin_product_audit\/\{auditId\}[\s\S]*allow read: if isAdmin\(\);[\s\S]*allow create, update, delete: if false;/u);
});
