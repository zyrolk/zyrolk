import { spawnSync } from "node:child_process";

const requiredHosts = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FUNCTIONS_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST",
] as const;

const loopbackHost = /^(?:127\.0\.0\.1|localhost):\d+$/u;
for (const variable of requiredHosts) {
  const value = String(process.env[variable] || "").trim();
  if (!loopbackHost.test(value)) {
    throw new Error(`${variable} must point to a local emulator before running critical emulator tests.`);
  }
}

const projectId = String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").trim();
if (!projectId.startsWith("demo-")) {
  throw new Error("Critical emulator tests require a demo-* Firebase project ID.");
}

const testFiles = [
  "tests/adminProductApiE2EEmulatorSH4Final.test.ts",
  "tests/adminProductIdentityE2EEmulatorSH4A.test.ts",
  "tests/orderFulfilmentSafetySH7A.test.ts",
  "tests/orderPrivateAttributionSH7B.test.ts",
  "tests/orderFulfilmentGroupsSH7C.test.ts",
  "tests/orderFulfilmentTrackingSH7D.test.ts",
  "tests/orderFulfilmentNotificationsSH7E.test.ts",
  "tests/productCommercialMigrationBatchSafetySH5C.test.ts",
  "tests/storageSecurityEmulatorSprint1.test.ts",
  "tests/supplierManualJobConcurrencyEmulatorSH2Final.test.ts",
  "tests/supplierProductReviewE2EEmulatorSH3Final.test.ts",
  "tests/supplierRemovedProductE2EEmulatorSH2Final.test.ts",
  "tests/supplierReviewIdentityConcurrencyEmulatorSH2Final.test.ts",
  "tests/supplierSecurityEmulatorSprint8.test.ts",
] as const;

const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-concurrency=1",
  "--test-reporter=tap",
  ...testFiles,
], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.error) throw result.error;
const output = `${result.stdout || ""}\n${result.stderr || ""}`;
if (/#\s*SKIP\b/iu.test(output)) {
  throw new Error("A required emulator-critical test was skipped.");
}
if (result.status !== 0) process.exitCode = result.status ?? 1;
