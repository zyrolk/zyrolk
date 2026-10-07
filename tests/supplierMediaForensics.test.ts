import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  projectSupplierMediaForensicEvidence,
  SupplierMediaForensicEvidence,
} from "../functions/src/api/suppliers/supplierMediaForensics";
import { explainSupplierQueueEligibility } from "../functions/src/scheduled/supplierReviewQueue";

const now = Date.parse("2026-10-05T12:00:00.000Z");
const sourceRecord = {
  queueState: "queued",
  nextRetryAt: "2026-10-05T11:59:00.000Z",
  supplierSnapshot: { imageUrls: ["https://supplier.example/image.jpg"] },
};

test("queued due item is eligible and preserves the worker selection explanation", () => {
  const result = explainSupplierQueueEligibility(sourceRecord, now);
  assert.equal(result.eligibleNow, true);
  assert.deepEqual(result.reasons, ["ELIGIBLE_NOW"]);
  assert.equal(result.blockingPredicate, null);
});

test("active lease is blocked until its durable expiry", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "processing",
    leaseId: "worker:1:1",
    leaseExpiresAt: "2026-10-05T12:05:00.000Z",
  }, now);
  assert.equal(result.eligibleNow, false);
  assert.deepEqual(result.reasons, ["ACTIVE_LEASE", "LEASE_NOT_EXPIRED"]);
});

test("expired leased item is eligible for the worker recovery pass", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "leased",
    leaseId: "worker:1:1",
    leaseExpiresAt: "2026-10-05T11:55:00.000Z",
  }, now);
  assert.equal(result.eligibleNow, true);
  assert.deepEqual(result.reasons, ["ELIGIBLE_NOW", "EXPIRED_LEASE"]);
});

test("future retry is not eligible until nextRetryAt", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "retryable_failure",
    nextRetryAt: "2026-10-05T12:10:00.000Z",
  }, now);
  assert.equal(result.eligibleNow, false);
  assert.deepEqual(result.reasons, ["RETRY_NOT_DUE"]);
});

test("due retryable failure is eligible without changing its retry state", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "retryable_failure",
    retryCount: 1,
    retryLimit: 3,
  }, now);
  assert.equal(result.eligibleNow, true);
  assert.equal(result.reasons.includes("ELIGIBLE_NOW"), true);
});

test("retry exhausted dead-letter item is blocked", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "dead_letter",
    retryCount: 3,
    retryLimit: 3,
  }, now);
  assert.equal(result.eligibleNow, false);
  assert.deepEqual(result.reasons, ["RETRY_EXHAUSTED"]);
});

test("permanent dead-letter item is blocked without being presented as retryable", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "dead_letter",
    failureClassification: "permanent",
    retryCount: 1,
    retryLimit: 3,
  }, now);
  assert.equal(result.eligibleNow, false);
  assert.equal(result.reasons.includes("PERMANENT_FAILURE"), true);
  assert.equal(result.reasons.includes("RETRY_EXHAUSTED"), false);
});

test("review-pending ready item is not selected again", () => {
  const result = explainSupplierQueueEligibility({
    ...sourceRecord,
    queueState: "review_pending",
    mediaStatus: "ready",
    managedMedia: [{
      contentHash: "asset-hash",
      firebaseStorageUrl: "https://storage.example/asset.webp",
      originalSupplierUrl: "https://supplier.example/image.jpg",
      imageStatus: "ready",
      isPrimary: true,
      variants: { large: { storageUrl: "https://storage.example/asset.webp" } },
    }],
  }, now);
  assert.equal(result.eligibleNow, false);
  assert.deepEqual(result.reasons, ["ALREADY_READY"]);
});

test("missing durable lifecycle fields remain unknown instead of being fabricated", () => {
  const result = explainSupplierQueueEligibility({
    supplierSnapshot: { imageUrls: ["https://supplier.example/image.jpg"] },
  }, now);
  assert.equal(result.eligibleNow, null);
  assert.deepEqual(result.reasons, ["UNKNOWN_STATE"]);
  assert.match(result.blockingPredicate || "", /queueState is not recorded/);
});

test("diagnostic projection is read-only and does not expose raw media payloads", async () => {
  const calls: string[] = [];
  const emptySnapshot = { size: 0, docs: [] as Array<{ data: () => Record<string, unknown> }> };
  const db = {
    collection(name: string) {
      calls.push(`collection:${name}`);
      return {
        doc() {
          return {
            async get() { return { exists: true, data: () => ({ queueWorkerStatus: "idle" }) }; },
          };
        },
        where() { return this; },
        limit() { return this; },
        async get() { return emptySnapshot; },
      };
    },
  };
  const evidence = await projectSupplierMediaForensicEvidence(db as never, "review-1", {
    queueState: "processing",
    supplierId: "dropex",
    supplierSku: "ASN0047",
    supplierSnapshot: { imageUrls: ["https://supplier.example/image.jpg"] },
  }, now) as SupplierMediaForensicEvidence;
  assert.equal(evidence.supplierSku, "ASN0047");
  assert.equal(evidence.queue.eligibleNow, null);
  assert.equal(evidence.media.sourceImageCount, 1);
  assert.equal("supplierSnapshot" in evidence, false);
  assert.equal(calls.includes("collection:supplier_review_queue"), false);
});

test("diagnostic endpoint is Admin-protected and has no mutation route", () => {
  const routes = readFileSync(new URL("../functions/src/api/routes/supplier.ts", import.meta.url), "utf8");
  assert.match(routes, /app\.get\("\/api\/supplier-review-queue\/diagnostics", requireSupplierHubAdmin/u);
  assert.doesNotMatch(routes, /app\.(post|patch|delete)\("\/api\/supplier-review-queue\/diagnostics/u);
});
