import assert from "node:assert/strict";
import test from "node:test";
import { buildSupplierOnboardingSource } from "../src/services/supplierSourceOnboarding";
import {
  projectSupplierSourceForAdmin,
  sanitizeSupplierSource,
} from "../functions/src/api/suppliers/supplierAdminConfiguration";
import {
  isSupplierAutomaticSyncEnabled,
  isSupplierSourceEligibleForSync,
  supplierSourceAutoSyncSchedule,
} from "../functions/src/scheduled/supplierSync";
import { resolveSupplierSourceAutoSyncSchedule as resolveUiSupplierSourceAutoSyncSchedule } from "../src/services/supplierSourceUtils";

const baseSource = buildSupplierOnboardingSource({
  id: "dropex-main",
  supplierName: "Dropex Main",
  supplierAccountId: "supplier-account-1",
  supplierType: "dropex",
  credentialProfile: "dropex-production",
});

const sanitize = (overrides: Record<string, unknown>) => sanitizeSupplierSource({
  ...baseSource,
  ...overrides,
  settings: {
    ...(baseSource.settings as Record<string, unknown>),
    ...(overrides.settings as Record<string, unknown> | undefined),
  },
});

test("Auto to Manual writes Off to both canonical and legacy schedule fields", () => {
  const saved = sanitize({
    syncSchedule: "1 Hour",
    settings: { autoSync: "Off" },
  });

  assert.equal(saved.settings.autoSync, "Off");
  assert.equal(saved.syncSchedule, "Off");
});

test("Manual to Auto writes the selected cadence to both schedule fields", () => {
  const saved = sanitize({
    syncSchedule: "Off",
    settings: { autoSync: "3 Hours" },
  });

  assert.equal(saved.settings.autoSync, "3 Hours");
  assert.equal(saved.syncSchedule, "3 Hours");
});

test("legacy source documents use syncSchedule only when canonical autoSync is absent", () => {
  const legacy = { ...baseSource, syncSchedule: "6 Hours", settings: { productLimit: "All" } };
  const saved = sanitizeSupplierSource(legacy);
  const projected = projectSupplierSourceForAdmin(legacy, "dropex-main");

  assert.equal(saved.settings.autoSync, "6 Hours");
  assert.equal(saved.syncSchedule, "6 Hours");
  assert.equal((projected.settings as Record<string, unknown>)?.autoSync, "6 Hours");
  assert.equal(projected.syncSchedule, "6 Hours");
});

test("Global OFF blocks scheduled traversal even when the source is Auto", () => {
  const source = sanitize({ syncSchedule: "1 Hour", settings: { autoSync: "1 Hour" } });
  const scheduledSource = { id: "dropex-main", ...source };
  const globalOff = { autoSyncEnabled: false };

  assert.equal(isSupplierAutomaticSyncEnabled(globalOff), false);
  assert.equal(supplierSourceAutoSyncSchedule(scheduledSource), "1 Hour");
  assert.equal(
    isSupplierAutomaticSyncEnabled(globalOff)
      && isSupplierSourceEligibleForSync(scheduledSource, globalOff, "scheduled", Date.now()),
    false,
  );
});

test("Global ON does not make a Manual source scheduled-eligible", () => {
  const source = sanitize({ syncSchedule: "1 Hour", settings: { autoSync: "Off" } });
  const scheduledSource = { id: "dropex-main", ...source };
  const globalOn = { autoSyncEnabled: true };

  assert.equal(isSupplierAutomaticSyncEnabled(globalOn), true);
  assert.equal(supplierSourceAutoSyncSchedule(scheduledSource), "Off");
  assert.equal(isSupplierSourceEligibleForSync(scheduledSource, globalOn, "scheduled", Date.now()), false);
});

test("UI and scheduler resolve the same canonical schedule with legacy fallback", () => {
  const cases = [
    ["Off", "1 Hour", "Off"],
    [undefined, "3 Hours", "3 Hours"],
    ["1 Hour", "Off", "1 Hour"],
    ["unknown", "unknown", "Off"],
  ] as const;

  cases.forEach(([canonical, legacy, expected]) => {
    assert.equal(resolveUiSupplierSourceAutoSyncSchedule(canonical, legacy), expected);
    assert.equal(supplierSourceAutoSyncSchedule({
      id: "dropex-main",
      settings: { autoSync: canonical },
      syncSchedule: legacy,
    }), expected);
  });
});
