import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSupplierCommerceAvailability,
  supplierCostWasProvided,
  supplierStockWasProvided,
} from "../functions/src/api/suppliers/supplierCommerceSemantics";
import { ProductParser } from "../functions/src/api/suppliers/a2z/ProductParser";
import { ProductParser as DropexProductParser } from "../functions/src/api/suppliers/dropex/ProductParser";
import { buildSupplierImportWarnings } from "../functions/src/api/suppliers/supplierProductImport";
import {
  calculateSupplierInitialPricing,
} from "../functions/src/scheduled/supplierSyncSettings";
import {
  calculateSupplierProfit,
  createSupplierReviewDraft,
} from "../src/services/supplierReviewEditor";
import {
  formatSupplierCostLabel,
  formatSupplierStockLabel,
  readSupplierCommerceAvailability,
} from "../src/services/supplierCommerceSemantics";

const atf0080ThinRow = {
  productDetail: {
    id: 1206,
    name: "Electric Knife Sharpener Swifty Sharp",
    sku: "ATF0080",
    sellingPrice: 1000,
    description: "Sharpens knives quickly.",
    image: "atf0080-main.jpg",
    onHandInventory: 0,
    openInventory: 0,
    dedicatedInventory: 0,
    productCategoryId: 7,
  },
};

test("missing A2Z cost is unavailable and not marked provided", () => {
  const parsed = ProductParser.parseJsonPayload({ sku: "A2Z-MISSING-COST", title: "No cost product" });
  assert.equal(parsed.wholesalePrice, 0);
  assert.equal(supplierCostWasProvided(parsed), false);
  assert.equal(supplierStockWasProvided(parsed), false);
  assert.equal(formatSupplierCostLabel(parsed.wholesalePrice, supplierCostWasProvided(parsed)), "Not supplied");
});

test("missing A2Z stock is unavailable while explicit zero stays known", () => {
  const missing = ProductParser.parseJsonPayload({ sku: "A2Z-NO-STOCK", title: "No stock product" });
  assert.equal(supplierStockWasProvided(missing), false);
  assert.equal(formatSupplierStockLabel(missing.inventoryLevel, supplierStockWasProvided(missing)), "Not supplied");

  const explicitZero = ProductParser.parseJsonPayload({ sku: "A2Z-ZERO-STOCK", title: "Zero stock product", bal: 0 });
  assert.equal(explicitZero.inventoryLevel, 0);
  assert.equal(supplierStockWasProvided(explicitZero), true);
  assert.equal(formatSupplierStockLabel(explicitZero.inventoryLevel, supplierStockWasProvided(explicitZero)), "0 / Out of stock");
});

test("valid A2Z cost and stock remain provided and numeric", () => {
  const parsed = ProductParser.parseJsonPayload({
    sku: "A2Z-VALID",
    title: "Valid product",
    wholesale_price: 1250,
    bal: 5,
  });
  assert.equal(parsed.wholesalePrice, 1250);
  assert.equal(parsed.inventoryLevel, 5);
  assert.equal(supplierCostWasProvided(parsed), true);
  assert.equal(supplierStockWasProvided(parsed), true);
  const profit = calculateSupplierProfit(parsed.recommendedRetailPrice || 1500, parsed.wholesalePrice, true);
  assert.equal(profit.available, true);
});

test("re-parsing normalized A2Z output does not falsely mark missing commerce fields as provided", () => {
  const minimal = ProductParser.parseJsonPayload({ sku: "A2Z-REPARSE", title: "Reparse product" });
  const reparsed = ProductParser.parseJsonPayload(minimal as unknown as Record<string, unknown>);
  assert.equal(supplierCostWasProvided(reparsed), false);
  assert.equal(supplierStockWasProvided(reparsed), false);
});

test("valid Dropex cost and stock remain numeric with profit available", () => {
  const parsed = DropexProductParser.parseCatalogItem({
    productDetail: {
      id: 99,
      name: "Valid Dropex Product",
      sku: "DPX-VALID",
      reSellingPrice: 650,
      sellingPrice: 1000,
      onHandInventory: 12,
      description: "Valid product",
      image: "valid.jpg",
    },
  });
  assert.equal(parsed.wholesalePrice, 650);
  assert.equal(parsed.inventoryLevel, 12);
  assert.equal(supplierCostWasProvided(parsed), true);
  assert.equal(supplierStockWasProvided(parsed), true);
  const profit = calculateSupplierProfit(1000, 650, true);
  assert.equal(profit.available, true);
  assert.equal(profit.profit, 350);
});

test("missing supplier cost is not treated as provided for Dropex thin rows", () => {
  const parsed = DropexProductParser.parseCatalogItem(atf0080ThinRow);
  assert.equal(supplierCostWasProvided(parsed), false);
  assert.equal(supplierStockWasProvided(parsed), true);
  assert.equal(parsed.wholesalePrice, 0);
  assert.equal(parsed.inventoryLevel, 0);
  assert.equal(parsed.recommendedRetailPrice, 1000);
});

test("missing cost displays Not supplied and does not imply fake profit", () => {
  assert.equal(formatSupplierCostLabel(0, false), "Not supplied");
  const profit = calculateSupplierProfit(1000, 0, false);
  assert.equal(profit.available, false);
  assert.equal(profit.profit, null);
  assert.equal(profit.marginPercent, null);
});

test("explicit stock zero is preserved and labeled Out of stock", () => {
  const parsed = DropexProductParser.parseCatalogItem(atf0080ThinRow);
  assert.equal(parsed.inventoryLevel, 0);
  assert.equal(formatSupplierStockLabel(0, true), "0 / Out of stock");
});

test("missing stock is distinguishable from explicit zero", () => {
  const parsed = DropexProductParser.parseCatalogItem({
    productDetail: {
      id: 1,
      name: "No stock field",
      sku: "NO-STOCK",
      sellingPrice: 500,
    },
  });
  assert.equal(supplierStockWasProvided(parsed), false);
  assert.equal(formatSupplierStockLabel(0, false), "Not supplied");
});

test("market/reference price stays separate from supplier cost in pricing helper", () => {
  const pricing = calculateSupplierInitialPricing(undefined, 1000, 10, 15);
  assert.equal(pricing.sellingPrice, 1000);
  assert.equal(pricing.comparePrice, 1000);
});

test("buildSupplierImportWarnings flags missing supplier cost", () => {
  const parsed = DropexProductParser.parseCatalogItem(atf0080ThinRow);
  const warnings = buildSupplierImportWarnings(parsed, { price: 1000, stock: 0 });
  assert.ok(warnings.some((warning) => warning.code === "missing_cost"));
});

test("createSupplierReviewDraft preserves ATF0080 stock zero with unavailable cost", () => {
  const draft = createSupplierReviewDraft({
    id: "review-atf0080",
    productName: "Electric Knife Sharpener Swifty Sharp",
    supplierCode: "ATF0080",
    costPrice: undefined as unknown as number,
    marketPrice: 1000,
    stock: 0,
    productPayload: {
      name: "Electric Knife Sharpener Swifty Sharp",
      supplierItemCode: "ATF0080",
      price: 1000,
      marketPrice: 1000,
      stock: 0,
      description: "Sharpens knives quickly.",
      supplierMetadata: {
        supplierCostAvailable: false,
        supplierStockAvailable: true,
        providedFields: ["stock"],
      },
    } as never,
    comparison: { comparisonStatus: "NEW_PRODUCT" },
  });
  assert.equal(draft.supplierCostAvailable, false);
  assert.equal(draft.supplierStockAvailable, true);
  assert.equal(draft.stock, 0);
  assert.equal(formatSupplierCostLabel(draft.costPrice, draft.supplierCostAvailable), "Not supplied");
});

test("legacy A2Z queue items without availability metadata keep valid cost and stock", () => {
  const draft = createSupplierReviewDraft({
    id: "a2z-watch-1",
    productName: "Supplier Watch",
    supplierCode: "A2Z-100",
    costPrice: 1000,
    marketPrice: 1500,
    stock: 5,
    productPayload: {
      name: "Supplier Watch",
      price: 1500,
      costPrice: 1000,
      marketPrice: 1500,
      stock: 5,
      supplierItemCode: "A2Z-100",
    } as never,
  });
  assert.equal(draft.supplierCostAvailable, true);
  assert.equal(draft.supplierStockAvailable, true);
  assert.equal(draft.costPrice, 1000);
  assert.equal(draft.stock, 5);
});

test("readSupplierCommerceAvailability uses persisted metadata flags", () => {
  const availability = readSupplierCommerceAvailability({
    supplierMetadata: {
      supplierCostAvailable: false,
      supplierStockAvailable: true,
    },
  });
  assert.deepEqual(availability, {
    supplierCostAvailable: false,
    supplierStockAvailable: true,
  });
  assert.deepEqual(buildSupplierCommerceAvailability({ providedFields: ["costPrice", "stock"] }), {
    supplierCostAvailable: true,
    supplierStockAvailable: true,
  });
});
