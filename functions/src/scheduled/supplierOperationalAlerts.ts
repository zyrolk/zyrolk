import { Firestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getRuntimeConfig } from "../api/config";
import { adminDb } from "../api/firebase";
import {
  recordSupplierOperationalAlert,
  SupplierOperationalAlertInput,
} from "../api/suppliers/supplierOperationalAlerts";

const DEFAULT_ALERT_MONITOR_SCHEDULE = "every 5 minutes";
const DEFAULT_QUEUE_AGE_THRESHOLD_MS = 60 * 60 * 1000;
const MONITOR_QUERY_LIMIT = 100;

export const SUPPLIER_OPERATIONAL_ALERT_MONITOR_SCHEDULE = String(
  process.env.SUPPLIER_OPERATIONAL_ALERT_MONITOR_SCHEDULE || DEFAULT_ALERT_MONITOR_SCHEDULE,
).trim() || DEFAULT_ALERT_MONITOR_SCHEDULE;

const timestampMillis = (value: unknown): number => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  return 0;
};

const mediaFailureReason = (record: Record<string, unknown>): string => {
  const failures = Array.isArray(record.mediaFailures) ? record.mediaFailures : [];
  const latest = failures.at(-1);
  if (latest && typeof latest === "object" && !Array.isArray(latest)) {
    return String((latest as Record<string, unknown>).reason || "");
  }
  return String(record.lastFailureReason || "");
};

export interface SupplierOperationalAlertEvaluationResult {
  detected: number;
  supplierFailures: number;
  deadLetters: number;
  mediaFailures: number;
  queueAgeExceeded: boolean;
}

export async function evaluateSupplierOperationalAlerts(
  db: Firestore,
  now = Date.now(),
  report: (input: SupplierOperationalAlertInput) => Promise<unknown> = (input) => recordSupplierOperationalAlert(
    db,
    input,
    { notificationEmail: getRuntimeConfig().adminEmail },
  ),
): Promise<SupplierOperationalAlertEvaluationResult> {
  const nowIso = new Date(now).toISOString();
  const [supplierSnapshot, deadLetterSnapshot, oldestQueueSnapshot, settingsSnapshot, mediaFailureSnapshot] = await Promise.all([
    db.collection("supplierSources").where("connectionStatus", "==", "Failed").limit(MONITOR_QUERY_LIMIT).get(),
    db.collection("supplier_review_queue")
      .where("queueState", "==", "dead_letter")
      .orderBy("queueCreatedAt", "desc")
      .limit(MONITOR_QUERY_LIMIT)
      .get(),
    db.collection("supplier_review_queue")
      .where("queueState", "in", ["queued", "review_pending", "retryable_failure"])
      .orderBy("queueCreatedAt", "asc")
      .limit(1)
      .get(),
    db.collection("supplier_settings").doc("config").get(),
    db.collection("supplier_review_queue")
      .where("mediaStatus", "in", ["failed", "partial"])
      .limit(MONITOR_QUERY_LIMIT)
      .get(),
  ]);

  const alerts: SupplierOperationalAlertInput[] = [];
  for (const document of supplierSnapshot.docs) {
    const source = document.data();
    const supplierId = String(source.supplierId || document.id);
    const metadata = {
      sourceId: document.id,
      failureClassification: source.lastFailureClassification || null,
      lastFailedSyncAt: source.lastFailedSyncAt || null,
      lastError: source.lastError || null,
      monitorDetectedAt: nowIso,
    };
    alerts.push({
      category: "supplier_connection_failure",
      severity: "critical",
      supplierId,
      message: "A configured supplier connection is currently unavailable.",
      technicalMetadata: metadata,
    });
    const lastFailure = timestampMillis(source.lastFailedSyncAt);
    const lastSuccess = timestampMillis(source.lastSuccessfulSyncAt || source.lastSync);
    if (lastFailure > 0 && lastFailure >= lastSuccess) {
      alerts.push({
        category: "supplier_sync_failure",
        severity: "critical",
        supplierId,
        batchId: String(source.syncBatchId || "") || null,
        technicalMetadata: metadata,
      });
    }
  }

  for (const document of deadLetterSnapshot.docs) {
    const item = document.data();
    alerts.push({
      category: "dead_letter_created",
      severity: "critical",
      supplierId: String(item.supplierId || item.sourceId || "") || null,
      queueItemId: document.id,
      jobId: String(item.jobId || "") || null,
      batchId: String(item.batchId || "") || null,
      technicalMetadata: {
        retryCount: item.retryCount || 0,
        failureClassification: item.failureClassification || null,
        lastFailureReason: item.lastFailureReason || null,
        deadLetteredAt: item.deadLetteredAt || null,
      },
    });
  }

  const oldestQueueDocument = oldestQueueSnapshot.docs[0];
  const oldestQueueCreatedAt = oldestQueueDocument
    ? timestampMillis(oldestQueueDocument.data().queueCreatedAt || oldestQueueDocument.data().createdAt)
    : 0;
  const queueAgeMs = oldestQueueCreatedAt > 0 ? Math.max(0, now - oldestQueueCreatedAt) : 0;
  const queueAgeExceeded = queueAgeMs >= DEFAULT_QUEUE_AGE_THRESHOLD_MS;
  if (queueAgeExceeded) {
    alerts.push({
      category: "queue_age_threshold_exceeded",
      severity: "critical",
      dedupeScope: "supplier-review-processing",
      technicalMetadata: {
        queueAgeMs,
        thresholdMs: DEFAULT_QUEUE_AGE_THRESHOLD_MS,
        oldestQueueItemId: oldestQueueDocument?.id || null,
      },
    });
  }

  const settings = settingsSnapshot.exists ? settingsSnapshot.data() || {} : {};
  if (String(settings.queueWorkerStatus || "").toLowerCase() === "failed") {
    alerts.push({
      category: "queue_worker_failure",
      severity: "critical",
      dedupeScope: "supplier-review-worker",
      technicalMetadata: { queueWorkerLastFailureAt: settings.queueWorkerLastFailureAt || null },
    });
  }
  if (String(settings.schedulerStatus || "").toLowerCase() === "failed") {
    alerts.push({
      category: "scheduler_failure",
      severity: "critical",
      jobId: String(settings.schedulerLastRunBatchId || "") || null,
      batchId: String(settings.schedulerLastRunBatchId || "") || null,
      dedupeScope: "supplier-sync-scheduler",
      technicalMetadata: { schedulerLastRunFinishedAt: settings.schedulerLastRunFinishedAt || null },
    });
  }

  for (const document of mediaFailureSnapshot.docs) {
    const item = document.data();
    const reason = mediaFailureReason(item);
    const common: SupplierOperationalAlertInput = {
      category: "media_processing_failure",
      severity: "critical",
      supplierId: String(item.supplierId || item.sourceId || "") || null,
      queueItemId: document.id,
      jobId: String(item.jobId || "") || null,
      batchId: String(item.batchId || "") || null,
      technicalMetadata: {
        mediaStatus: item.mediaStatus || null,
        reason,
        retryCount: item.retryCount || 0,
      },
    };
    alerts.push(common);
    if (/firebase storage|storage|upload failed|bucket/iu.test(reason)) {
      alerts.push({ ...common, category: "storage_failure" });
    }
  }

  for (const alert of alerts) await report({ ...alert, now });
  return {
    detected: alerts.length,
    supplierFailures: supplierSnapshot.size,
    deadLetters: deadLetterSnapshot.size,
    mediaFailures: mediaFailureSnapshot.size,
    queueAgeExceeded,
  };
}

export const scheduledSupplierOperationalAlerts = onSchedule({
  schedule: SUPPLIER_OPERATIONAL_ALERT_MONITOR_SCHEDULE,
  timeZone: "Asia/Colombo",
  timeoutSeconds: 120,
  memory: "256MiB",
}, async () => {
  await evaluateSupplierOperationalAlerts(adminDb);
});
