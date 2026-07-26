import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { adminDb } from "../api/firebase";
import {
  calculateSupplierSyncJobProgress,
  cancelRunningSupplierSyncJob,
  completeSupplierSyncJob,
  failSupplierSyncJob,
  heartbeatSupplierSyncJob,
  leaseSupplierSyncJob,
  listDueSupplierSyncJobIds,
  recoverExpiredSupplierSyncJobs,
  SupplierSyncJobProgressInput,
  waitSupplierSyncJob,
} from "../api/suppliers/supplierSyncJobs";
import { A2Z_SECRETS } from "../config/secrets";
import { runSupplierSync } from "./supplierSync";

const JOB_HEARTBEAT_INTERVAL_MS = 30_000;
export const SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE = String(process.env.SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE || "every 1 minutes").trim() || "every 1 minutes";

export interface SupplierSyncJobWorkerResult {
  jobId: string;
  outcome: "completed" | "waiting" | "failed" | "cancelled" | "skipped";
}

export function isLocalSupplierSyncWorkerRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && !env.K_SERVICE && !env.FUNCTION_TARGET;
}

export async function processSupplierSyncJob(jobId: string, now = Date.now()): Promise<SupplierSyncJobWorkerResult> {
  const workerId = `supplier-sync-worker-${jobId}-${now}`;
  const lease = await leaseSupplierSyncJob(adminDb, jobId, workerId, now);
  if (!lease) return { jobId, outcome: "skipped" };

  const startedAtMs = Date.parse(String(lease.job.startedAt || lease.job.createdAt || "")) || now;
  let cancellationRequested = false;
  let leaseLost = false;
  let progress = calculateSupplierSyncJobProgress(startedAtMs, {
    phase: "starting",
    totalSources: lease.job.sourceIds.length,
  }, now);
  let heartbeatInFlight: Promise<void> | null = null;

  const heartbeat = async (input: SupplierSyncJobProgressInput = {}): Promise<void> => {
    progress = calculateSupplierSyncJobProgress(startedAtMs, {
      ...progress,
      ...input,
    }, Date.now());
    const result = await heartbeatSupplierSyncJob(
      adminDb,
      jobId,
      workerId,
      lease.leaseId,
      progress,
    );
    cancellationRequested = result.cancellationRequested;
  };

  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = heartbeat().catch((error) => {
      leaseLost = true;
      logger.error("Supplier sync job heartbeat failed.", { jobId, workerId, error });
    }).finally(() => {
      heartbeatInFlight = null;
    });
  }, JOB_HEARTBEAT_INTERVAL_MS);

  try {
    await heartbeat();
    if (cancellationRequested) {
      await cancelRunningSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress);
      return { jobId, outcome: "cancelled" };
    }
    const result = await runSupplierSync({
      trigger: lease.job.trigger,
      sourceIds: lease.job.sourceIds,
      batchId: jobId,
      control: {
        reportProgress: heartbeat,
        shouldCancel: () => cancellationRequested || leaseLost,
      },
    });
    await heartbeat({
      phase: result.status === "Partial" ? "waiting" : "finalizing",
      completedSources: result.suppliers.length,
      pagesProcessed: result.pagesProcessed,
      productsDiscovered: result.productsDiscovered,
      productsScanned: result.productsScanned,
      productsQueued: result.productsQueued,
      productsFailed: result.productsFailed,
      currentSourceId: null,
    });

    if (cancellationRequested) {
      await cancelRunningSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress);
      return { jobId, outcome: "cancelled" };
    }
    if (result.waitingRecommended === true) {
      await waitSupplierSyncJob(
        adminDb,
        jobId,
        workerId,
        lease.leaseId,
        progress,
        result.status === "Partial"
          ? "Catalogue traversal paused at a durable cursor and will resume."
          : "Another synchronization worker currently owns the execution lease.",
      );
      return { jobId, outcome: "waiting" };
    }
    if (result.status === "Failed" || result.status === "Partial") {
      await failSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress, new Error(result.errors.join("; ") || "Supplier synchronization failed."));
      return { jobId, outcome: "failed" };
    }
    await completeSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, result as unknown as Record<string, unknown>, progress);
    return { jobId, outcome: "completed" };
  } catch (error) {
    if (cancellationRequested) {
      await cancelRunningSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress);
      return { jobId, outcome: "cancelled" };
    }
    await failSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress, error);
    logger.error("Supplier sync job execution failed.", { jobId, workerId, error });
    return { jobId, outcome: "failed" };
  } finally {
    clearInterval(heartbeatTimer);
    if (heartbeatInFlight) await heartbeatInFlight;
  }
}

export async function dispatchDueSupplierSyncJobs(now = Date.now(), limit = 10): Promise<SupplierSyncJobWorkerResult[]> {
  await recoverExpiredSupplierSyncJobs(adminDb, now, limit);
  const jobIds = await listDueSupplierSyncJobIds(adminDb, now, limit);
  const results: SupplierSyncJobWorkerResult[] = [];
  // The existing catalogue pipeline intentionally owns one global mutation lock.
  // Sequential dispatch avoids creating lock contention while each job retains
  // its independent durable lease and source cursor.
  for (const jobId of jobIds) results.push(await processSupplierSyncJob(jobId));
  return results;
}

export const supplierSyncJobCreated = onDocumentCreated({
  document: "supplier_sync_jobs/{jobId}",
  retry: true,
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: A2Z_SECRETS,
}, async (event) => {
  const jobId = event.params.jobId;
  await processSupplierSyncJob(jobId);
});

export const scheduledSupplierSyncJobDispatcher = onSchedule({
  schedule: SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: A2Z_SECRETS,
}, async () => {
  await dispatchDueSupplierSyncJobs();
});
