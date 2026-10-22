import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSupplierReviewProjectionDiagnostic,
  emitSupplierReviewProjectionDiagnostic,
  SUPPLIER_REVIEW_PROJECTION_DIAGNOSTIC_SCHEMA_VERSION,
} from "../functions/src/scheduled/supplierReviewProjectionDiagnostics";
import { buildSupplierReviewBusinessQueueProjection } from "../functions/src/scheduled/supplierReviewQueue";

const logger = () => {
  const entries: Array<{ level: "info" | "warn"; message: string; context: Record<string, unknown> }> = [];
  return {
    entries,
    info(message: string, context: Record<string, unknown>) {
      entries.push({ level: "info", message, context });
    },
    warn(message: string, context: Record<string, unknown>) {
      entries.push({ level: "warn", message, context });
    },
  };
};

test("projection diagnostics record bounded structured fields for a committed match", () => {
  const output = buildSupplierReviewProjectionDiagnostic({
    writer: "scheduledSupplierQueueWorker",
    operation: "completion_write",
    outcome: "commit_success",
    queueItemId: "dropex-asn0095-k",
    runId: "scheduled-202610220403",
    correlationId: "queue-correlation-1",
    expectedProjection: { classes: ["actionable", "new_products"], version: 4 },
    persistedProjection: { classes: ["new_products", "actionable"], version: 4 },
    previousProjection: { classes: ["missing_details"], version: 4 },
    categoryDecisionRequired: false,
    zeroStock: false,
    existingDocument: true,
    transactionAttempts: 2,
  });

  assert.equal(output.event, "supplier_review_projection_write_diagnostic");
  assert.equal(output.diagnosticSchemaVersion, SUPPLIER_REVIEW_PROJECTION_DIAGNOSTIC_SCHEMA_VERSION);
  assert.equal(output.projectionMismatch, false);
  assert.equal(output.previousProjectionMismatch, true);
  assert.equal(output.transactionAttempts, 2);
  assert.equal(output.existingDocument, true);
  assert.deepEqual(output.expectedClasses, ["actionable", "new_products"]);
  assert.deepEqual(output.persistedClasses, ["new_products", "actionable"]);
  assert.equal(output.previousProjectionVersion, 4);
});

test("mismatched projections are warned after the caller confirms its write", () => {
  const testLogger = logger();
  emitSupplierReviewProjectionDiagnostic(testLogger, {
    writer: "supplierSync",
    operation: "supplier_sync_queue_write",
    outcome: "commit_success",
    queueItemId: "dropex-azkch-3430",
    runId: "scheduled-202610221133",
    expectedProjection: { classes: ["actionable", "category_decision_required"], version: 4 },
    persistedProjection: { classes: ["actionable", "missing_details"], version: 4 },
    categoryDecisionRequired: true,
    zeroStock: false,
    existingDocument: null,
  });

  assert.equal(testLogger.entries.length, 1);
  assert.equal(testLogger.entries[0].level, "warn");
  assert.match(testLogger.entries[0].message, /differed from canonical/u);
  assert.equal(testLogger.entries[0].context.projectionMismatch, true);
});

test("matching projections are recorded without a mismatch warning", () => {
  const testLogger = logger();
  emitSupplierReviewProjectionDiagnostic(testLogger, {
    writer: "supplierSync",
    operation: "supplier_sync_queue_write",
    outcome: "commit_success",
    queueItemId: "dropex-aju0099-k",
    expectedProjection: { classes: ["actionable", "new_products"], version: 4 },
    persistedProjection: { classes: ["new_products", "actionable"], version: 4 },
  });

  assert.equal(testLogger.entries.length, 1);
  assert.equal(testLogger.entries[0].level, "info");
  assert.equal(testLogger.entries[0].context.projectionMismatch, false);
});

test("diagnostic fields reject unsafe identifiers and never accept raw payloads", () => {
  const output = buildSupplierReviewProjectionDiagnostic({
    writer: "supplierSync https://supplier.example/catalog?token=secret",
    operation: "supplier_sync_queue_write",
    outcome: "pre_commit_intent",
    queueItemId: "https://supplier.example/item?authorization=bearer-secret",
    runId: "run with raw product description and password=secret",
    expectedProjection: {
      classes: ["actionable", "drop table supplier_review_queue", "category_decision_required"],
      version: 4,
    },
    persistedProjection: { classes: ["actionable"], version: 3 },
  });
  const serialized = JSON.stringify(output);

  assert.equal(output.writer, null);
  assert.equal(output.queueItemId, null);
  assert.equal(output.runId, null);
  assert.deepEqual(output.expectedClasses, ["actionable", "category_decision_required"]);
  assert.doesNotMatch(serialized, /bearer-secret|password=secret|supplier\.example|drop table/iu);
});

test("diagnostic logger failures cannot affect projection processing", () => {
  assert.doesNotThrow(() => emitSupplierReviewProjectionDiagnostic({
    info() { throw new Error("logging unavailable"); },
    warn() { throw new Error("logging unavailable"); },
  }, {
    writer: "supplierSync",
    operation: "supplier_sync_queue_write",
    outcome: "commit_success",
    expectedProjection: { classes: ["actionable"], version: 4 },
    persistedProjection: { classes: ["missing_details"], version: 4 },
  }));
});

test("diagnostics do not mutate or change canonical projection output", () => {
  const record = {
    status: "Pending",
    queueState: "review_pending",
    sourceId: "dropex",
    comparisonStatus: "NEW_PRODUCT",
    productValidation: { readyToPublish: false, missingFields: ["category"] },
    productPayload: { category: "", stock: 8 },
    stock: 8,
  } as Record<string, unknown>;
  const before = structuredClone(record);
  const projection = buildSupplierReviewBusinessQueueProjection(record as never);
  const diagnostic = buildSupplierReviewProjectionDiagnostic({
    writer: "supplierSync",
    operation: "supplier_sync_queue_write",
    outcome: "commit_success",
    expectedProjection: projection,
    persistedProjection: projection,
  });

  assert.deepEqual(record, before);
  assert.equal(diagnostic.projectionMismatch, false);
  assert.equal(diagnostic.event, "supplier_review_projection_write_diagnostic");
});
