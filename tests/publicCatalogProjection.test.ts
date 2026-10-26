import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parsePublicCatalogCursor,
  parsePublicCatalogCategoryIds,
  parsePublicCatalogIds,
  parsePublicCatalogLimit,
  projectPublicCatalogProduct,
} from "../functions/src/api/products/publicCatalog";

const safeProduct = {
  name: "Public catalogue item",
  description: "Customer-facing description",
  price: 2_500,
  originalPrice: 3_000,
  imageUrl: "https://cdn.example.test/item.webp",
  imageUrls: ["https://cdn.example.test/item.webp", "http://unsafe.example.test/item.webp"],
  category: "electronics",
  stock: 4,
  rating: 4.5,
  reviewsCount: 3,
  isActive: true,
  isNew: true,
  specs: { Colour: "Blue" },
  sku: "PRIVATE-SKU",
  supplierId: "PRIVATE-SUPPLIER",
  costPrice: 800,
  supplierInternalNotes: "PRIVATE-NOTE",
};

test("public product projection exposes customer fields and excludes commercial fields", () => {
  const projected = projectPublicCatalogProduct("public-1", safeProduct);

  assert.ok(projected);
  assert.equal(projected.id, "public-1");
  assert.equal(projected.price, 2_500);
  assert.equal(projected.stock, 4);
  assert.deepEqual(projected.imageUrls, ["https://cdn.example.test/item.webp"]);
  assert.equal("sku" in projected, false);
  assert.equal("supplierId" in projected, false);
  assert.equal("costPrice" in projected, false);
  assert.equal("supplierInternalNotes" in projected, false);
});

test("inactive or malformed public products are fail-closed", () => {
  assert.equal(projectPublicCatalogProduct("inactive", { ...safeProduct, isActive: false }), null);
  assert.equal(projectPublicCatalogProduct("legacy", { ...safeProduct, isActive: undefined }), null);
  assert.equal(projectPublicCatalogProduct("nameless", { ...safeProduct, name: "" }), null);
});

test("catalog request identifiers are bounded and reject path traversal", () => {
  assert.equal(parsePublicCatalogLimit(100), 24);
  assert.equal(parsePublicCatalogLimit("invalid"), 24);
  assert.equal(parsePublicCatalogCursor("../private"), undefined);
  assert.deepEqual(parsePublicCatalogIds("first,second,first,../private,third"), ["first", "second", "third"]);
  assert.deepEqual(parsePublicCatalogCategoryIds("electronics,home-garden"), ["electronics", "home-garden"]);
  assert.ok(parsePublicCatalogIds(Array.from({ length: 100 }, (_, index) => `item-${index}`).join(",")).length <= 64);
});

test("public catalog routes are App Check protected by the common API middleware", () => {
  const app = readFileSync("functions/src/api/app.ts", "utf8");
  const routes = readFileSync("functions/src/api/routes/publicCatalog.ts", "utf8");
  assert.match(app, /registerPublicCatalogRoutes\(app\)/u);
  assert.match(app, /isFunctionsEmulatorRequest[\s\S]*isPublicProductMetadataRequest/u);
  assert.match(routes, /\/api\/catalog\/products/u);
  assert.doesNotMatch(app, /isPublicCatalogRequest/u);
});

test("public catalog API does not replace server-authoritative checkout reads", () => {
  const checkout = readFileSync("functions/src/api/routes/checkout.ts", "utf8");
  assert.match(checkout, /adminDb\.collection\("products"\)/u);
  assert.match(checkout, /isProductExplicitlyActive/u);
  assert.match(checkout, /expectedUnitPrice/u);
});
