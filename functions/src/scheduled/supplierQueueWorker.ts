import { FieldValue, Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { adminDb } from "../api/firebase";
import { A2Z_SECRETS } from "../config/secrets";
import {
  getSupplierReviewQueueMetrics,
  processDueSupplierReviewQueueItems,
  recoverExpiredSupplierReviewQueueLeases,
} from "./supplierReviewQueue";
import {
  recordSupplierOperationalAlertSafely,
  resolveSupplierOperationalAlertSafely,
} from "../api/suppliers/supplierOperationalAlerts";
import { recordSupplierQueueDepthMetric } from "../api/suppliers/supplierCloudMonitoring";

const WORKER_LOCK_ID = "scheduled_supplier_queue_worker";
const WORKER_LEASE_MS = 4 * 60 * 1000;
const WORKER_HEARTBEAT_INTERVAL_MS = 60 * 1000;
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

export async function heartbeatSupplierQueueWorkerLock(
  db: Firestore,
  workerId: string,
  now = Date.now(),
  leaseMs = WORKER_LEASE_MS,
): Promise<boolean> {
  const reference = db.collection("supplier_sync_locks").doc(WORKER_LOCK_ID);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const lock = snapshot.data() || {};
    const expiresAt = Date.parse(String(lock.lockedUntil || ""));
    if (
      lock.status !== "running"
      || lock.owner !== workerId
      || !Number.isFinite(expiresAt)
      || expiresAt <= now
    ) return false;
    transaction.set(reference, {
      lockedUntil: new Date(now + leaseMs).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      heartbeatCount: Number(lock.heartbeatCount || 0) + 1,
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
    return true;
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
  let workerHeartbeat: ReturnType<typeof setInterval> | null = null;
  let workerHeartbeatInFlight: Promise<void> = Promise.resolve();
  let workerOwnershipFailure: Error | null = null;
  try {
    workerHeartbeat = setInterval(() => {
      workerHeartbeatInFlight = workerHeartbeatInFlight.then(async () => {
        if (workerOwnershipFailure) return;
        const renewed = await heartbeatSupplierQueueWorkerLock(adminDb, workerId);
        if (!renewed) {
          workerOwnershipFailure = new Error("Supplier queue worker lock was lost during processing.");
          logger.error("Supplier review queue worker lost lock ownership.", { workerId });
        }
      }).catch((error) => {
        workerOwnershipFailure = error instanceof Error
          ? error
          : new Error("Supplier queue worker lock heartbeat failed.");
        logger.error("Supplier review queue worker heartbeat failed.", { workerId, error });
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    const verifyWorkerOwnership = async (): Promise<void> => {
      await workerHeartbeatInFlight;
      if (workerOwnershipFailure) throw workerOwnershipFailure;
    };
    await verifyWorkerOwnership();
    const recoveredLeases = await recoverExpiredSupplierReviewQueueLeases(adminDb, Date.now(), limit);
    await verifyWorkerOwnership();
    const results = await processDueSupplierReviewQueueItems(adminDb, workerId, Date.now(), limit, {
      currentTime: Date.now,
      verifyWorkerOwnership,
    });
    await verifyWorkerOwnership();
    const completedAt = Date.now();
    const metrics = await getSupplierReviewQueueMetrics(adminDb, completedAt);
    recordSupplierQueueDepthMetric({
      queueDepth: metrics.queueDepth,
      retryBacklog: metrics.retryBacklog,
      activeWorkers: metrics.activeWorkers,
      workerId,
    });
    if ((metrics.oldestQueueAgeMs || 0) >= 60 * 60 * 1000) {
      await recordSupplierOperationalAlertSafely({
        category: "queue_age_threshold_exceeded",
        severity: "critical",
        dedupeScope: "supplier-review-processing",
        technicalMetadata: { queueAgeMs: metrics.oldestQueueAgeMs, thresholdMs: 60 * 60 * 1000 },
      });
    } else {
      await resolveSupplierOperationalAlertSafely({
        category: "queue_age_threshold_exceeded",
        dedupeScope: "supplier-review-processing",
      });
    }
    await resolveSupplierOperationalAlertSafely({
      category: "queue_worker_failure",
      dedupeScope: "supplier-review-worker",
    });
    await adminDb.collection("supplier_settings").doc("config").set({
      queueWorkerStatus: "idle",
      queueWorkerLastRunAt: new Date(completedAt).toISOString(),
      queueWorkerLastRun: {
        recoveredLeases,
        processed: results.length,
        completed: results.filter((result) => result.outcome === "completed").length,
        retryableFailures: results.filter((result) => result.outcome === "retryable_failure").length,
        deadLetters: results.filter((result) => result.outcome === "dead_letter").length,
      },
      queueMetrics: { ...metrics, measuredAt: new Date(completedAt).toISOString() },
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
    const failedAt = Date.now();
    await adminDb.collection("supplier_settings").doc("config").set({
      queueWorkerStatus: "failed",
      queueWorkerLastFailureAt: new Date(failedAt).toISOString(),
    }, { merge: true });
    await recordSupplierOperationalAlertSafely({
      category: "queue_worker_failure",
      severity: "critical",
      dedupeScope: "supplier-review-worker",
      technicalMetadata: {
        workerId,
        failedAt: new Date(failedAt).toISOString(),
        reason: error instanceof Error ? error.message : String(error || "Queue worker failed."),
      },
    });
    throw error;
  } finally {
    if (workerHeartbeat) clearInterval(workerHeartbeat);
    await workerHeartbeatInFlight;
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
