import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHiddenTaxAiBenchmarkReference,
  type TaxAiProductEvidence,
  type TaxAiTaxonomyCatalog,
} from "../functions/src/api/ai/taxAiFoundation";
import { TaxAiShadowRunner, benchmarkShadowRun, type TaxAiShadowRecord } from "../functions/src/api/ai/taxAiShadowRunner";
import type { TaxAiProvider } from "../functions/src/api/ai/taxAiProvider";

const catalog: TaxAiTaxonomyCatalog = {
  categories: [
    { id: "sunglasses", name: "Sunglasses", isActive: true },
    { id: "tools", name: "Tools", isActive: true },
  ],
};

const evidence = (sku: string, title: string): TaxAiProductEvidence => ({ sourceId: "dropex", supplierSku: sku, title });
const records: TaxAiShadowRecord[] = [
  { id: "b", evidence: evidence("B", "Tool set") },
  { id: "a", evidence: evidence("A", "Women's Sunglasses") },
];

function fixtureProvider(): TaxAiProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "fixture",
    model: "fixture-1",
    calls,
    async classify(request) {
      calls.push(request.evidence.supplierSku);
      const sunglassesResult = request.evidence.title.includes("Sunglasses");
      return {
        taxonomy: { categoryId: sunglassesResult ? "sunglasses" : "tools", subcategoryId: null, confidence: 0.95, alternateCandidates: [] },
        risk: { policyReviewRequired: false, flags: [] },
        decision: "HIGH_CONFIDENCE",
      };
    },
  };
}

test("runner processes deterministic ID order, bounds calls, and resumes from a checkpoint", async () => {
  const provider = fixtureProvider();
  const runner = new TaxAiShadowRunner(provider, catalog);
  const first = await runner.run(records, null, { batchSize: 1, maxCalls: 1, minimumHighConfidence: 0.9, sleep: async () => undefined });
  assert.deepEqual(first.results.map((result) => result.id), ["a"]);
  assert.equal(first.complete, false);
  assert.equal(first.providerCalls, 1);
  assert.equal(first.checkpoint.lastProcessedId, "a");
  assert.equal(first.results[0].classification.promptVersion, "tax-ai-1");
  assert.equal(first.results[0].classification.model, "fixture-1");
  const second = await runner.run(records, first.checkpoint, { batchSize: 1, maxCalls: 1, minimumHighConfidence: 0.9, sleep: async () => undefined });
  assert.deepEqual(second.results.map((result) => result.id), ["b"]);
  assert.equal(second.complete, true);
  assert.deepEqual(provider.calls, ["A", "B"]);
});

test("runner cache is keyed by evidence and avoids repeated provider calls", async () => {
  const provider = fixtureProvider();
  const cache = new Map();
  const duplicateRecords: TaxAiShadowRecord[] = [
    { id: "a", evidence: evidence("same", "Women's Sunglasses") },
    { id: "b", evidence: evidence("same", "Women's Sunglasses") },
  ];
  const result = await new TaxAiShadowRunner(provider, catalog).run(duplicateRecords, null, { cache, batchSize: 2, maxCalls: 2, sleep: async () => undefined });
  assert.equal(provider.calls.length, 1);
  assert.equal(result.results.filter((item) => item.fromCache).length, 1);
  assert.equal(result.groups.HIGH_CONFIDENCE, 2);
});

test("provider failure is bounded and produces REVIEW/AI_PENDING rather than publication authority", async () => {
  let calls = 0;
  const provider: TaxAiProvider = {
    id: "failing",
    model: "failing-1",
    async classify() { calls += 1; throw new Error("provider offline"); },
  };
  const result = await new TaxAiShadowRunner(provider, catalog).run([{ id: "a", evidence: evidence("A", "Women's Sunglasses") }], null, { maxAttempts: 2, maxCalls: 2, retryBackoffMs: 0, sleep: async () => undefined });
  assert.equal(calls, 2);
  assert.equal(result.groups.REVIEW, 1);
  assert.equal(result.results[0].classification.decision, "REVIEW");
  assert.ok(result.results[0].classification.reasons.includes("AI_PENDING"));
  assert.equal(result.complete, true);
});

test("timeout/retry behavior stays bounded and a malformed response cannot become high confidence", async () => {
  let calls = 0;
  const provider: TaxAiProvider = {
    id: "retry",
    model: "retry-1",
    async classify() {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { taxonomy: { categoryId: "hallucinated", subcategoryId: null, confidence: 1 }, decision: "HIGH_CONFIDENCE" };
    },
  };
  const result = await new TaxAiShadowRunner(provider, catalog).run([{ id: "a", evidence: evidence("A", "Women's Sunglasses") }], null, { maxAttempts: 2, maxCalls: 2, retryBackoffMs: 0, sleep: async () => undefined });
  assert.equal(calls, 2);
  assert.equal(result.results[0].classification.decision, "REVIEW");
  assert.equal(result.results[0].classification.taxonomy.categoryId, null);
});

test("benchmark reports calibration metrics without inventing a confidence threshold", () => {
  const provider = fixtureProvider();
  const references = [
    buildHiddenTaxAiBenchmarkReference({ id: "a", evidence: records[1].evidence, canonicalCategoryId: "sunglasses" }),
    buildHiddenTaxAiBenchmarkReference({ id: "b", evidence: records[0].evidence, canonicalCategoryId: "tools" }),
  ];
  return new TaxAiShadowRunner(provider, catalog).run(records, null, { batchSize: 2, maxCalls: 2, sleep: async () => undefined }).then((run) => {
    const metrics = benchmarkShadowRun(references, run.results);
    assert.equal(metrics.total, 2);
    assert.equal(metrics.categoryTop1Accuracy, 1);
    assert.equal(metrics.highConfidenceCoverage, 1);
    assert.equal(metrics.highConfidenceFalsePositiveRate, 0);
    assert.equal(metrics.policyRiskFalsePositiveRate, null);
  });
});

test("checkpoint cannot resume against a different input set", async () => {
  const runner = new TaxAiShadowRunner(fixtureProvider(), catalog);
  await assert.rejects(() => runner.run(records, { schemaVersion: "tax-ai-1", lastProcessedId: "a", inputCount: 99 }));
  await assert.rejects(() => runner.run(records, { schemaVersion: "tax-ai-1", lastProcessedId: "missing", inputCount: records.length }));
});
