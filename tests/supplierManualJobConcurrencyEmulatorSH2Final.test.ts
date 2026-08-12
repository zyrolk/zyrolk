import assert from "node:assert/strict";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import {
  createSupplierSyncJob,
  SupplierSyncJobConflictError,
} from "../functions/src/api/suppliers/supplierSyncJobs";

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const manualInput = (sourceId: string, category = "Phones") => ({
  trigger: "manual" as const,
  sourceIds: [sourceId],
  requestedBy: { uid: "emulator-admin", email: "admin@example.test" },
  syncRequest: {
    mode: "full" as const,
    filters: { category },
    pageSize: 25,
    totalProductLimit: 100,
  },
});

test("SH-2 manual sync admission is atomic on the real Firestore Emulator", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 60_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);

  await t.test("identical concurrent requests share one active logical job", async () => {
    const sourceId = "manual-emulator-identical";
    const results = await Promise.all([
      createSupplierSyncJob(adminDb, manualInput(sourceId), 1_000),
      createSupplierSyncJob(adminDb, manualInput(sourceId), 1_000),
    ]);
    assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results.filter((result) => result.deduplicated).length, 1);
    const lock = await adminDb.collection("supplier_sync_locks").doc(`source-${sourceId}`).get();
    assert.equal(lock.data()?.manualReservationJobId, results[0].job.id);
  });

  await t.test("different concurrent controls fail closed without overlapping work", async () => {
    const sourceId = "manual-emulator-conflict";
    const results = await Promise.allSettled([
      createSupplierSyncJob(adminDb, manualInput(sourceId, "Phones"), 2_000),
      createSupplierSyncJob(adminDb, manualInput(sourceId, "Laptops"), 2_000),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof SupplierSyncJobConflictError);
    const lock = await adminDb.collection("supplier_sync_locks").doc(`source-${sourceId}`).get();
    assert.ok(String(lock.data()?.manualReservationJobId || ""));
  });

  await t.test("different supplier sources reserve independently", async () => {
    const [sourceA, sourceB] = await Promise.all([
      createSupplierSyncJob(adminDb, manualInput("manual-emulator-source-a"), 3_000),
      createSupplierSyncJob(adminDb, manualInput("manual-emulator-source-b"), 3_000),
    ]);
    assert.equal(sourceA.created, true);
    assert.equal(sourceB.created, true);
    assert.notEqual(sourceA.job.id, sourceB.job.id);
  });
});
