import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { adminDb } from "../api/firebase";
import { A2Z_SECRETS } from "../config/secrets";
import {
  getSupplierReviewQueueMetrics,
  processDueSupplierReviewQueueItems,
  recoverExpiredSupplierReviewQueueLeases,
} from "./supplierReviewQueue";

const WORKER_LOCK_ID = "scheduled_supplier_queue_worker";
const WORKER_LEASE_MS = 4 * 60 * 1000;
const DEFAULT_QUEUE_WORKER_SCHEDULE = "every 5 minutes";
export const SUPPLIER_QUEUE_WORKER_SCHEDULE = String(process.env.SUPPLIER_QUEUE_WORKER_SCHEDULE || DEFAULT_QUEUE_WORKER_SCHEDULE).trim() || DEFAULT_QUEUE_WORKER_SCHEDULE;

async function acquireQueueWorkerLock(workerId: string, now: number): Promise<boolean> {
  const reference = adminDb.collection("supplier_sync_locks").doc(WORKER_LOCK_ID);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() || {};
    const expires = Date.parse(String(data.lockedUntil || ""));
    if (data.status === "running" && Number.isFinite(expires) && expires > now) return false;
    transaction.set(reference, {
      status: "running",
      owner: workerId,
      activeSyncCount: 1,
      startedAt: new Date(now).toISOString(),
      lockedUntil: new Date(now + WORKER_LEASE_MS).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
    return true;
  });
}

async function releaseQueueWorkerLock(workerId: string): Promise<void> {
  const reference = adminDb.collection("supplier_sync_locks").doc(WORKER_LOCK_ID);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.data()?.owner !== workerId) return;
    transaction.set(reference, {
      status: "idle",
      activeSyncCount: 0,
      finishedAt: new Date().toISOString(),
      lockedUntil: FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  });
}

export interface SupplierQueueWorkerResult {
  workerId: string;
  skipped: boolean;
  recoveredLeases: number;
  processed: number;
  completed: number;
  retryableFailures: number;
  deadLetters: number;
}

/** Queue-only worker. Supplier catalog sync deliberately does not call this path. */
export async function runSupplierQueueWorker(now = Date.now(), limit = 100): Promise<SupplierQueueWorkerResult> {
  const workerId = `supplier-queue-${now}`;
  if (!await acquireQueueWorkerLock(workerId, now)) {
    return { workerId, skipped: true, recoveredLeases: 0, processed: 0, completed: 0, retryableFailures: 0, deadLetters: 0 };
  }
  try {
    const recoveredLeases = await recoverExpiredSupplierReviewQueueLeases(adminDb, now, limit);
    const results = await processDueSupplierReviewQueueItems(adminDb, workerId, now, limit);
    const metrics = await getSupplierReviewQueueMetrics(adminDb, now);
    await adminDb.collection("supplier_settings").doc("config").set({
      queueWorkerStatus: "idle",
      queueWorkerLastRunAt: new Date(now).toISOString(),
      queueWorkerLastRun: {
        recoveredLeases,
        processed: results.length,
        completed: results.filter((result) => result.outcome === "completed").length,
        retryableFailures: results.filter((result) => result.outcome === "retryable_failure").length,
        deadLetters: results.filter((result) => result.outcome === "dead_letter").length,
      },
      queueMetrics: { ...metrics, measuredAt: new Date(now).toISOString() },
    }, { merge: true });
    return {
      workerId,
      skipped: false,
      recoveredLeases,
      processed: results.length,
      completed: results.filter((result) => result.outcome === "completed").length,
      retryableFailures: results.filter((result) => result.outcome === "retryable_failure").length,
      deadLetters: results.filter((result) => result.outcome === "dead_letter").length,
    };
  } catch (error) {
    logger.error("Supplier review queue worker failed.", { workerId, error });
    await adminDb.collection("supplier_settings").doc("config").set({
      queueWorkerStatus: "failed",
      queueWorkerLastFailureAt: new Date(now).toISOString(),
    }, { merge: true });
    throw error;
  } finally {
    await releaseQueueWorkerLock(workerId);
  }
}

export const scheduledSupplierQueueWorker = onSchedule({
  schedule: SUPPLIER_QUEUE_WORKER_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: A2Z_SECRETS,
}, async () => {
  await runSupplierQueueWorker();
});
