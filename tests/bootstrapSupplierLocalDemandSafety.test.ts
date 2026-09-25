import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupplierLocalDemandBootstrapSafety,
  BOOTSTRAP_PRODUCTION_PROJECT,
} from "../scripts/bootstrapSupplierLocalDemand";

const production = (overrides: Partial<Parameters<typeof assertSupplierLocalDemandBootstrapSafety>[0]> = {}) => ({
  initializedProjectId: BOOTSTRAP_PRODUCTION_PROJECT,
  requestedProjectId: BOOTSTRAP_PRODUCTION_PROJECT,
  firestoreEmulatorHost: "",
  apply: false,
  ...overrides,
});

test("bootstrap guard rejects a missing project before the database path is entered", () => {
  assert.throws(
    () => assertSupplierLocalDemandBootstrapSafety({ ...production(), requestedProjectId: undefined }),
    /explicit --project/u,
  );
});

test("bootstrap guard rejects a project mismatch", () => {
  assert.throws(
    () => assertSupplierLocalDemandBootstrapSafety({ ...production(), requestedProjectId: "demo-other" }),
    /does not match/u,
  );
});

test("production dry-run requires the explicit project and remains read-only", () => {
  assert.doesNotThrow(() => assertSupplierLocalDemandBootstrapSafety(production()));
});

test("production apply requires exact confirmation", () => {
  assert.throws(
    () => assertSupplierLocalDemandBootstrapSafety({ ...production(), apply: true }),
    /confirm-production=/u,
  );
  assert.throws(
    () => assertSupplierLocalDemandBootstrapSafety({ ...production(), apply: true, productionConfirmation: "wrong" }),
    /confirm-production=/u,
  );
  assert.doesNotThrow(() => assertSupplierLocalDemandBootstrapSafety({
    ...production(),
    apply: true,
    productionConfirmation: BOOTSTRAP_PRODUCTION_PROJECT,
  }));
});

test("demo emulator dry-run and apply require the emulator and exact target", () => {
  const demo = {
    initializedProjectId: "demo-zyro-ci",
    requestedProjectId: "demo-zyro-ci",
    firestoreEmulatorHost: "127.0.0.1:8080",
  };
  assert.doesNotThrow(() => assertSupplierLocalDemandBootstrapSafety({ ...demo, apply: false }));
  assert.doesNotThrow(() => assertSupplierLocalDemandBootstrapSafety({ ...demo, apply: true }));
  assert.throws(
    () => assertSupplierLocalDemandBootstrapSafety({ ...demo, firestoreEmulatorHost: "", apply: false }),
    /requires FIRESTORE_EMULATOR_HOST/u,
  );
});

test("production cannot run with emulator configuration", () => {
  assert.throws(
    () => assertSupplierLocalDemandBootstrapSafety({ ...production(), firestoreEmulatorHost: "127.0.0.1:8080" }),
    /cannot run with FIRESTORE_EMULATOR_HOST/u,
  );
});
