import assert from "node:assert/strict";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import {
  createSupplierSyncJob,
  SupplierSyncJobConflictError,
} from "../functions/src/api/suppliers/supplierSyncJobs";
import { fingerprintSupplierSyncRequest } from "../functions/src/api/suppliers/supplierSyncRequest";

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
// This suite validates admission, not worker completion. Keeping its jobs
// legitimately not-due prevents the real on-create worker from completing a
// missing-source fixture and releasing the reservation between contenders.
const admissionTestNow = Date.now() + (60 * 60 * 1000);

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
      createSupplierSyncJob(adminDb, manualInput(sourceId), admissionTestNow),
      createSupplierSyncJob(adminDb, manualInput(sourceId), admissionTestNow),
    ]);
    assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results.filter((result) => result.deduplicated).length, 1);
    const lock = await adminDb.collection("supplier_sync_locks").doc(`source-${sourceId}`).get();
    assert.equal(lock.data()?.manualReservationJobId, results[0].job.id);
  });

  await t.test("different concurrent controls fail closed without overlapping work", async () => {
    const sourceId = "manual-emulator-conflict";
    const phones = manualInput(sourceId, "Phones");
    const laptops = manualInput(sourceId, "Laptops");
    assert.notEqual(
      fingerprintSupplierSyncRequest(phones.syncRequest),
      fingerprintSupplierSyncRequest(laptops.syncRequest),
    );
    const results = await Promise.allSettled([
      createSupplierSyncJob(adminDb, phones, admissionTestNow),
      createSupplierSyncJob(adminDb, laptops, admissionTestNow),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const fulfilled = results.find((result) => result.status === "fulfilled");
    assert.ok(fulfilled && fulfilled.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof SupplierSyncJobConflictError);
    const lock = await adminDb.collection("supplier_sync_locks").doc(`source-${sourceId}`).get();
    assert.equal(lock.data()?.manualReservationJobId, fulfilled.value.job.id);

    const fixtureJobs = await adminDb.collection("supplier_sync_jobs")
      .where("sourceIds", "array-contains", sourceId)
      .get();
    assert.equal(fixtureJobs.size, 1);
    assert.equal(fixtureJobs.docs[0].id, fulfilled.value.job.id);
    assert.equal(fixtureJobs.docs[0].data().state, "pending");
    assert.equal(fixtureJobs.docs[0].data().nextAttemptAt, new Date(admissionTestNow).toISOString());
    const storedFingerprint = fingerprintSupplierSyncRequest(fixtureJobs.docs[0].data().syncRequest);
    assert.ok([
      fingerprintSupplierSyncRequest(phones.syncRequest),
      fingerprintSupplierSyncRequest(laptops.syncRequest),
    ].includes(storedFingerprint));
  });

  await t.test("different supplier sources reserve independently", async () => {
    const [sourceA, sourceB] = await Promise.all([
      createSupplierSyncJob(adminDb, manualInput("manual-emulator-source-a"), admissionTestNow),
      createSupplierSyncJob(adminDb, manualInput("manual-emulator-source-b"), admissionTestNow),
    ]);
    assert.equal(sourceA.created, true);
    assert.equal(sourceB.created, true);
    assert.notEqual(sourceA.job.id, sourceB.job.id);
  });
});
