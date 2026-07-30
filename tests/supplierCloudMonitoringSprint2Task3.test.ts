import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSupplierCloudMetricLog,
  emitSupplierCloudMetric,
  SUPPLIER_CLOUD_METRIC_NAMES,
} from "../functions/src/api/suppliers/supplierCloudMonitoring";

const projectFile = (path: string): string => readFileSync(path, "utf8");

test("Supplier Hub emits a stable structured Cloud Monitoring payload", () => {
  const payload = buildSupplierCloudMetricLog({
    name: "supplier_sync_success",
    kind: "counter",
    value: 1,
    unit: "1",
    labels: { trigger: "manual" },
    context: { jobId: "job-1" },
    recordedAt: "2026-07-29T10:00:00.000Z",
  });

  assert.deepEqual(payload, {
    eventType: "supplier_hub_operational_metric",
    metricNamespace: "zyro.lk/supplier_hub",
    metricName: "supplier_sync_success",
    metricKind: "counter",
    metricValue: 1,
    metricUnit: "1",
    metricLabels: { trigger: "manual" },
    recordedAt: "2026-07-29T10:00:00.000Z",
    metricContext: { jobId: "job-1" },
  });
});

test("metric labels remain bounded and high-cardinality identifiers stay in log context", () => {
  const payload = buildSupplierCloudMetricLog({
    name: "supplier_queue_processing_duration_ms",
    kind: "distribution",
    value: 250,
    unit: "ms",
    labels: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`label-${index}`, index])),
    context: { queueItemId: "queue-123", supplierId: "supplier-123" },
  });

  assert.equal(Object.keys(payload.metricLabels).length, 8);
  assert.equal(payload.metricLabels.label_0, "0");
  assert.equal("queueItemId" in payload.metricLabels, false);
  assert.deepEqual(payload.metricContext, { queueItemId: "queue-123", supplierId: "supplier-123" });
});

test("monitoring failures are isolated from Supplier Hub business execution", () => {
  assert.doesNotThrow(() => emitSupplierCloudMetric({
    name: "supplier_manual_sync_requests",
    kind: "counter",
    value: 1,
    unit: "1",
  }, {
    info(): void {
      throw new Error("Cloud Logging unavailable");
    },
  }));
});

test("all required Supplier Hub metrics have deployable Cloud Monitoring definitions", () => {
  assert.deepEqual(SUPPLIER_CLOUD_METRIC_NAMES, [
    "supplier_sync_success",
    "supplier_sync_failure",
    "supplier_queue_depth",
    "supplier_queue_processing_duration_ms",
    "supplier_investigation_requests",
    "supplier_manual_sync_requests",
  ]);

  for (const name of SUPPLIER_CLOUD_METRIC_NAMES) {
    const definition = projectFile(`monitoring/supplier-hub/${name}.yaml`);
    assert.match(definition, new RegExp(`name: supplier_hub_${name.replace(/^supplier_/, "")}`));
    assert.match(definition, new RegExp(`jsonPayload\\.metricName=\\"${name}\\"`));
  }
});

test("metrics are recorded at authoritative sync, queue, and investigation boundaries", () => {
  const jobs = projectFile("functions/src/api/suppliers/supplierSyncJobs.ts");
  const syncWorker = projectFile("functions/src/scheduled/supplierSyncWorker.ts");
  const queueWorker = projectFile("functions/src/scheduled/supplierQueueWorker.ts");
  const reviewQueue = projectFile("functions/src/scheduled/supplierReviewQueue.ts");
  const routes = projectFile("functions/src/api/routes/supplier.ts");

  assert.match(jobs, /input\.trigger === "manual"[\s\S]*recordSupplierManualSyncRequestMetric/);
  assert.match(syncWorker, /recordSupplierSyncOutcomeMetric\(\{[\s\S]*outcome: "success"/);
  assert.match(syncWorker, /recordSupplierSyncOutcomeMetric\(\{[\s\S]*outcome: "failure"/);
  assert.match(queueWorker, /getSupplierReviewQueueMetrics[\s\S]*recordSupplierQueueDepthMetric/);
  assert.match(reviewQueue, /processSupplierReviewQueueItem[\s\S]*recordSupplierQueueProcessingDurationMetric/);
  assert.match(routes, /supplier-sync-investigation[\s\S]*recordSupplierInvestigationRequestMetric/);
});
