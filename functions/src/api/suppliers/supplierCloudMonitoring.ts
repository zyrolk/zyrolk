import { appLogger } from "../logging";

export const SUPPLIER_CLOUD_METRIC_NAMES = [
  "supplier_sync_success",
  "supplier_sync_failure",
  "supplier_queue_depth",
  "supplier_queue_processing_duration_ms",
  "supplier_investigation_requests",
  "supplier_manual_sync_requests",
] as const;

export type SupplierCloudMetricName = typeof SUPPLIER_CLOUD_METRIC_NAMES[number];
export type SupplierCloudMetricKind = "counter" | "gauge" | "distribution";

export interface SupplierCloudMetricInput {
  name: SupplierCloudMetricName;
  kind: SupplierCloudMetricKind;
  value: number;
  unit: "1" | "ms";
  labels?: Record<string, string | number | boolean | null | undefined>;
  context?: Record<string, unknown>;
  recordedAt?: string;
}

export interface SupplierCloudMetricLog extends Record<string, unknown> {
  eventType: "supplier_hub_operational_metric";
  metricNamespace: "zyro.lk/supplier_hub";
  metricName: SupplierCloudMetricName;
  metricKind: SupplierCloudMetricKind;
  metricValue: number;
  metricUnit: "1" | "ms";
  metricLabels: Record<string, string>;
  recordedAt: string;
}

interface SupplierMetricLogSink {
  info(message: string, context?: Record<string, unknown>): void;
}

const MAX_METRIC_LABELS = 8;
const MAX_LABEL_LENGTH = 80;

const metricValue = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;

const metricLabels = (
  labels: SupplierCloudMetricInput["labels"] = {},
): Record<string, string> => Object.fromEntries(Object.entries(labels)
  .filter(([, value]) => value !== null && value !== undefined)
  .slice(0, MAX_METRIC_LABELS)
  .map(([key, value]) => [
    key.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, MAX_LABEL_LENGTH),
    String(value).slice(0, MAX_LABEL_LENGTH),
  ]));

/**
 * Produces the stable JSON payload consumed by Cloud Logging log-based metrics.
 * Identifiers belong in context, never metricLabels, to keep metric cardinality bounded.
 */
export function buildSupplierCloudMetricLog(input: SupplierCloudMetricInput): SupplierCloudMetricLog {
  return {
    eventType: "supplier_hub_operational_metric",
    metricNamespace: "zyro.lk/supplier_hub",
    metricName: input.name,
    metricKind: input.kind,
    metricValue: metricValue(input.value),
    metricUnit: input.unit,
    metricLabels: metricLabels(input.labels),
    recordedAt: input.recordedAt || new Date().toISOString(),
    ...(input.context ? { metricContext: input.context } : {}),
  };
}

/** Monitoring is deliberately best-effort and can never interrupt Supplier Hub work. */
export function emitSupplierCloudMetric(
  input: SupplierCloudMetricInput,
  sink: SupplierMetricLogSink = appLogger,
): void {
  try {
    sink.info("Supplier Hub operational metric.", buildSupplierCloudMetricLog(input));
  } catch {
    // Cloud Logging failures must not affect synchronization or queue processing.
  }
}

export function recordSupplierSyncOutcomeMetric(input: {
  outcome: "success" | "failure";
  trigger: "manual" | "scheduled";
  jobId: string;
  sourceCount: number;
  productsScanned?: number;
  productsQueued?: number;
}): void {
  emitSupplierCloudMetric({
    name: input.outcome === "success" ? "supplier_sync_success" : "supplier_sync_failure",
    kind: "counter",
    value: 1,
    unit: "1",
    labels: { trigger: input.trigger },
    context: {
      jobId: input.jobId,
      sourceCount: input.sourceCount,
      productsScanned: input.productsScanned,
      productsQueued: input.productsQueued,
    },
  });
}

export function recordSupplierQueueDepthMetric(input: {
  queueDepth: number;
  retryBacklog: number;
  activeWorkers: number;
  workerId: string;
}): void {
  emitSupplierCloudMetric({
    name: "supplier_queue_depth",
    kind: "gauge",
    value: input.queueDepth,
    unit: "1",
    labels: { queue: "supplier_review" },
    context: {
      workerId: input.workerId,
      retryBacklog: input.retryBacklog,
      activeWorkers: input.activeWorkers,
    },
  });
}

export function recordSupplierQueueProcessingDurationMetric(input: {
  durationMs: number;
  outcome: string;
  queueItemId: string;
}): void {
  emitSupplierCloudMetric({
    name: "supplier_queue_processing_duration_ms",
    kind: "distribution",
    value: input.durationMs,
    unit: "ms",
    labels: { outcome: input.outcome },
    context: { queueItemId: input.queueItemId },
  });
}

export function recordSupplierInvestigationRequestMetric(input: {
  batchId: string;
  continuation: boolean;
}): void {
  emitSupplierCloudMetric({
    name: "supplier_investigation_requests",
    kind: "counter",
    value: 1,
    unit: "1",
    labels: { page: input.continuation ? "continuation" : "initial" },
    context: { batchId: input.batchId },
  });
}

export function recordSupplierManualSyncRequestMetric(input: {
  jobId: string;
  sourceCount: number;
  created: boolean;
}): void {
  emitSupplierCloudMetric({
    name: "supplier_manual_sync_requests",
    kind: "counter",
    value: 1,
    unit: "1",
    labels: {
      sourceScope: input.sourceCount === 0 ? "all" : input.sourceCount === 1 ? "single" : "multiple",
      jobResult: input.created ? "created" : "deduplicated",
    },
    context: { jobId: input.jobId, sourceCount: input.sourceCount },
  });
}
