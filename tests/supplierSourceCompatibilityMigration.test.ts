import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierSourceCompatibilityMigration,
  normalizeSupplierSourceConfig,
} from "../functions/src/api/suppliers/supplierSourceCompatibility";
import {
  projectSupplierSourceForAdmin,
  sanitizeSupplierSource,
} from "../functions/src/api/suppliers/supplierAdminConfiguration";

const legacyA2ZSource = {
  name: "A2Z Traders",
  type: "website",
  config: { targetUrl: "https://a2zdropshipping.lk/catalog", cssPriceSelector: ".price" },
  settings: { autoSync: "1 hour", productLimit: "50" },
  connectionStatus: "Connected",
};

test("legacy A2Z supplier sources receive an additive Sprint 7 registry migration without configuration loss", () => {
  const result = buildSupplierSourceCompatibilityMigration("a2z-traders", legacyA2ZSource, "2026-07-20T00:00:00.000Z");

  assert.equal(result.needsMigration, true);
  assert.equal(result.patch.supplierId, "a2z-traders");
  assert.equal(result.patch.connectorType, "a2z");
  assert.equal(result.patch.supplierType, undefined, "the existing legacy type remains authoritative");
  assert.equal(result.patch.sourceStatus, "active");
  assert.equal(result.patch.enabled, true);
  assert.equal(result.patch.currency, "LKR");
  assert.equal(result.patch.timezone, "Asia/Colombo");
  assert.equal(result.patch.syncSchedule, "1 hour");
  assert.deepEqual(result.patch.capabilities, ["catalog.fetch", "connection.test"]);
  assert.deepEqual(result.patch.authentication, { mode: "secret_manager" });
  assert.equal(result.patch.websiteUrl, "https://a2zdropshipping.lk/catalog");
  assert.equal(result.patch.endpoint, undefined, "an absent optional endpoint is not repeatedly written");
  assert.equal(result.patch.supplierRegistrySchemaVersion, 7);
  assert.equal(result.patch.config, undefined);
  assert.equal(result.patch.settings, undefined);

  const migrated = { ...legacyA2ZSource, ...result.patch };
  const canonical = normalizeSupplierSourceConfig("a2z-traders", migrated);
  assert.equal(canonical.connectorType, "a2z");
  assert.equal(canonical.enabled, true);
  assert.equal(canonical.websiteUrl, legacyA2ZSource.config.targetUrl);
  assert.deepEqual(migrated.config, legacyA2ZSource.config);
  assert.deepEqual(migrated.settings, legacyA2ZSource.settings);
  assert.equal(buildSupplierSourceCompatibilityMigration("a2z-traders", migrated).needsMigration, false);
});

test("registry projection recognizes a legacy A2Z source before and after the explicit migration", () => {
  const projected = projectSupplierSourceForAdmin(legacyA2ZSource, "a2z-traders");
  assert.equal(projected.connectorType, "a2z");
  assert.equal(projected.supplierId, "a2z-traders");
  assert.equal(projected.websiteUrl, legacyA2ZSource.config.targetUrl);
  assert.equal(projected.enabled, true);
  assert.equal(projected.sourceStatus, "active");
});

test("migrated legacy A2Z sources may retain global Secret Manager authentication during settings saves", () => {
  const migration = buildSupplierSourceCompatibilityMigration("a2z-traders", legacyA2ZSource, "2026-07-20T00:00:00.000Z");
  const migrated = { ...legacyA2ZSource, ...migration.patch };

  const sanitized = sanitizeSupplierSource({
    ...migrated,
    supplierName: "A2Z Traders",
  }, { existingSource: migrated });

  assert.equal(sanitized.connectorType, "a2z");
  assert.deepEqual(sanitized.authentication, { mode: "secret_manager" });
});

test("new A2Z sources still require a Secret Manager reference or credential profile", () => {
  assert.throws(() => sanitizeSupplierSource({
    supplierName: "New A2Z Supplier",
    supplierType: "a2z",
    connectorType: "a2z",
    websiteUrl: "https://supplier.example.com",
    authentication: { mode: "secret_manager" },
    supplierRegistrySchemaVersion: 7,
    supplierRegistryMigratedAt: "2026-07-20T00:00:00.000Z",
  }), /Secret Manager reference or credential profile is required/);
});

test("ordinary per-source Secret Manager references remain valid", () => {
  const sanitized = sanitizeSupplierSource({
    supplierName: "Referenced A2Z Supplier",
    supplierType: "a2z",
    connectorType: "a2z",
    websiteUrl: "https://supplier.example.com",
    authentication: { mode: "secret_manager", secretRef: "A2Z_REFERENCED_SUPPLIER" },
  });

  assert.deepEqual(sanitized.authentication, {
    mode: "secret_manager",
    secretRef: "A2Z_REFERENCED_SUPPLIER",
  });
});

test("Sprint 7 source migration is explicit, merge-only, and guarded before production writes", () => {
  const script = readFileSync("scripts/migrateSupplierSourcesSprint7.ts", "utf8");
  const packageJson = readFileSync("package.json", "utf8");
  assert.match(script, /process\.argv\.includes\("--apply"\)/);
  assert.match(script, /SUPPLIER_SOURCE_REGISTRY_MIGRATION_CONFIRM/);
  assert.match(script, /batch\.set\(document\.ref, migration\.patch, \{ merge: true \}\)/);
  assert.doesNotMatch(script, /\.delete\(/);
  assert.match(packageJson, /supplier:registry:sprint7:dry-run/);
  assert.match(packageJson, /supplier:registry:sprint7:apply/);
});
