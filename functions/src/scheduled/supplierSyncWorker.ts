import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { adminDb } from "../api/firebase";
import {
  accumulateSupplierSyncAttemptProgress,
  calculateSupplierSyncJobProgress,
  cancelRunningSupplierSyncJob,
  completeSupplierSyncJob,
  failSupplierSyncJob,
  heartbeatSupplierSyncJob,
  leaseSupplierSyncJob,
  listDueSupplierSyncJobIds,
  normalizeSupplierSyncJobProgress,
  recoverExpiredSupplierSyncJobs,
  SupplierSyncJobProgressInput,
  waitSupplierSyncJob,
} from "../api/suppliers/supplierSyncJobs";
import { API_SECRETS } from "../config/secrets";
import { runSupplierSync } from "./supplierSync";
import { recordSupplierOperationalAlertSafely } from "../api/suppliers/supplierOperationalAlerts";
import { recordSupplierSyncOutcomeMetric } from "../api/suppliers/supplierCloudMonitoring";

const JOB_HEARTBEAT_INTERVAL_MS = 30_000;
export const SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE = String(process.env.SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE || "every 1 minutes").trim() || "every 1 minutes";

export interface SupplierSyncJobWorkerResult {
  jobId: string;
  outcome: "completed" | "waiting" | "failed" | "cancelled" | "skipped";
}

export function isLocalSupplierSyncWorkerRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && !env.K_SERVICE && !env.FUNCTION_TARGET;
}

const reportSyncJobFailure = async (
  jobId: string,
  sourceIds: readonly string[],
  reason: unknown,
): Promise<void> => {
  const scopes: Array<string | null> = sourceIds.length ? [...sourceIds] : [null];
  await Promise.all(scopes.map((supplierId) => recordSupplierOperationalAlertSafely({
    category: "supplier_sync_failure",
    severity: "critical",
    supplierId,
    jobId,
    batchId: jobId,
    dedupeScope: supplierId ? undefined : "supplier-sync-jobs",
    technicalMetadata: {
      reason: reason instanceof Error ? reason.message : String(reason || "Supplier synchronization failed."),
    },
  })));
};

export async function processSupplierSyncJob(jobId: string, now = Date.now()): Promise<SupplierSyncJobWorkerResult> {
  const workerId = `supplier-sync-worker-${jobId}-${now}`;
  const lease = await leaseSupplierSyncJob(adminDb, jobId, workerId, now);
  if (!lease) return { jobId, outcome: "skipped" };

  const storedProgress = normalizeSupplierSyncJobProgress(lease.job, now);
  const startedAtMs = Date.parse(String(lease.job.startedAt || lease.job.createdAt || "")) || now;
  const attemptStartedAtMs = now;
  const activeElapsedBeforeAttemptMs = storedProgress.activeElapsedMs;
  const attemptCounterBase = {
    pagesProcessed: storedProgress.pagesProcessed,
    productsDiscovered: storedProgress.productsDiscovered,
    productsObserved: storedProgress.productsObserved,
    productsScanned: storedProgress.productsScanned,
    productsQueued: storedProgress.productsQueued,
    productsFailed: storedProgress.productsFailed,
  };
  let cancellationRequested = false;
  let leaseLost = false;
  let progress = calculateSupplierSyncJobProgress(startedAtMs, {
    ...storedProgress,
    phase: "starting",
    totalSources: storedProgress.totalSources || lease.job.sourceIds.length,
    activeElapsedMs: activeElapsedBeforeAttemptMs,
  }, now);
  let heartbeatQueue: Promise<void> = Promise.resolve();
  let timerHeartbeatInFlight: Promise<void> | null = null;

  const persistHeartbeat = async (input: SupplierSyncJobProgressInput = {}): Promise<void> => {
    const heartbeatAt = Date.now();
    progress = calculateSupplierSyncJobProgress(startedAtMs, {
      ...progress,
      ...input,
      activeElapsedMs: activeElapsedBeforeAttemptMs + Math.max(0, heartbeatAt - attemptStartedAtMs),
    }, heartbeatAt);
    const result = await heartbeatSupplierSyncJob(
      adminDb,
      jobId,
      workerId,
      lease.leaseId,
      progress,
    );
    cancellationRequested = result.cancellationRequested;
  };

  // Checkpoint reports and the timer share one write chain. This prevents an
  // older timer transaction from committing after a newer catalogue checkpoint.
  const heartbeat = (input: SupplierSyncJobProgressInput = {}): Promise<void> => {
    const operation = heartbeatQueue.then(() => persistHeartbeat(input));
    heartbeatQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const reportAttemptProgress = (input: SupplierSyncJobProgressInput): Promise<void> => {
    return heartbeat(accumulateSupplierSyncAttemptProgress(attemptCounterBase, input));
  };

  const heartbeatTimer = setInterval(() => {
    if (timerHeartbeatInFlight) return;
    timerHeartbeatInFlight = heartbeat().catch((error) => {
      leaseLost = true;
      logger.error("Supplier sync job heartbeat failed.", { jobId, workerId, error });
    }).finally(() => {
      timerHeartbeatInFlight = null;
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
      syncRequest: lease.job.syncRequest,
      control: {
        reportProgress: reportAttemptProgress,
        shouldCancel: () => cancellationRequested || leaseLost,
      },
    });
    await reportAttemptProgress({
      phase: result.status === "Partial" ? "waiting" : "finalizing",
      pagesProcessed: result.pagesProcessed,
      productsDiscovered: result.productsDiscovered,
      productsObserved: result.productsDiscovered,
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
      const failure = new Error(result.errors.join("; ") || "Supplier synchronization failed.");
      await failSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress, failure);
      await reportSyncJobFailure(jobId, lease.job.sourceIds, failure);
      recordSupplierSyncOutcomeMetric({
        outcome: "failure",
        trigger: lease.job.trigger,
        jobId,
        sourceCount: lease.job.sourceIds.length,
        productsScanned: result.productsScanned,
        productsQueued: result.productsQueued,
      });
      return { jobId, outcome: "failed" };
    }
    await completeSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, result as unknown as Record<string, unknown>, progress);
    if (result.status === "Success") {
      recordSupplierSyncOutcomeMetric({
        outcome: "success",
        trigger: lease.job.trigger,
        jobId,
        sourceCount: lease.job.sourceIds.length,
        productsScanned: result.productsScanned,
        productsQueued: result.productsQueued,
      });
    }
    return { jobId, outcome: "completed" };
  } catch (error) {
    if (cancellationRequested) {
      await cancelRunningSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress);
      return { jobId, outcome: "cancelled" };
    }
    await failSupplierSyncJob(adminDb, jobId, workerId, lease.leaseId, progress, error);
    await reportSyncJobFailure(jobId, lease.job.sourceIds, error);
    recordSupplierSyncOutcomeMetric({
      outcome: "failure",
      trigger: lease.job.trigger,
      jobId,
      sourceCount: lease.job.sourceIds.length,
      productsScanned: progress.productsScanned,
      productsQueued: progress.productsQueued,
    });
    logger.error("Supplier sync job execution failed.", { jobId, workerId, error });
    return { jobId, outcome: "failed" };
  } finally {
    clearInterval(heartbeatTimer);
    if (timerHeartbeatInFlight) await timerHeartbeatInFlight;
    await heartbeatQueue;
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
  secrets: API_SECRETS,
}, async (event) => {
  const jobId = event.params.jobId;
  await processSupplierSyncJob(jobId);
});

export const scheduledSupplierSyncJobDispatcher = onSchedule({
  schedule: SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 540,
  memory: "1GiB",
  secrets: API_SECRETS,
}, async () => {
  try {
    await dispatchDueSupplierSyncJobs();
  } catch (error) {
    await recordSupplierOperationalAlertSafely({
      category: "scheduler_failure",
      severity: "critical",
      dedupeScope: "supplier-sync-job-dispatcher",
      technicalMetadata: {
        dispatcher: "scheduledSupplierSyncJobDispatcher",
        reason: error instanceof Error ? error.message : String(error || "Supplier sync dispatcher failed."),
      },
    });
    throw error;
  }
});
