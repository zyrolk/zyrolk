import {
  benchmarkTaxAiResults,
  hashTaxAiEvidence,
  resultGroup,
  safeTaxAiReview,
  TAX_AI_SCHEMA_VERSION,
  validateTaxAiModelOutput,
  type TaxAiBenchmarkMetrics,
  type TaxAiClassification,
  type TaxAiProductEvidence,
  type TaxAiResultGroup,
  type TaxAiTaxonomyCatalog,
} from "./taxAiFoundation";
import type { TaxAiMediaInputStatus, TaxAiProvider } from "./taxAiProvider";

export interface TaxAiShadowRecord {
  readonly id: string;
  readonly evidence: TaxAiProductEvidence;
}

export interface TaxAiShadowCheckpoint {
  readonly schemaVersion: typeof TAX_AI_SCHEMA_VERSION;
  readonly lastProcessedId: string | null;
  readonly inputCount: number;
}

export interface TaxAiShadowOptions {
  readonly batchSize?: number;
  readonly maxCalls?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly retryBackoffMs?: number;
  readonly minimumHighConfidence?: number;
  readonly taxonomyFingerprint?: string;
  readonly cache?: Map<string, TaxAiClassification>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface TaxAiShadowRecordResult {
  readonly id: string;
  readonly evidenceHash: string;
  readonly group: TaxAiResultGroup;
  readonly classification: TaxAiClassification;
  readonly attempts: number;
  readonly fromCache: boolean;
  readonly mediaInputStatus: TaxAiMediaInputStatus;
}

export interface TaxAiShadowRunResult {
  readonly results: readonly TaxAiShadowRecordResult[];
  readonly groups: Readonly<Record<TaxAiResultGroup, number>>;
  readonly checkpoint: TaxAiShadowCheckpoint;
  readonly complete: boolean;
  readonly providerCalls: number;
  readonly errors: readonly string[];
}

const defaultSleep = async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sortedRecords(records: readonly TaxAiShadowRecord[]): TaxAiShadowRecord[] {
  const copy = [...records].sort((left, right) => left.id.localeCompare(right.id));
  if (copy.some((record, index) => index > 0 && copy[index - 1].id === record.id)) throw new Error("Tax-AI shadow records must have unique IDs.");
  return copy;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tax-AI provider timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyGroups(): Record<TaxAiResultGroup, number> {
  return { HIGH_CONFIDENCE: 0, REVIEW: 0, NO_MATCH: 0, POLICY_HOLD: 0, ERROR: 0 };
}

export class TaxAiShadowRunner {
  constructor(private readonly provider: TaxAiProvider, private readonly catalog: TaxAiTaxonomyCatalog) {}

  async run(records: readonly TaxAiShadowRecord[], checkpoint: TaxAiShadowCheckpoint | null = null, options: TaxAiShadowOptions = {}): Promise<TaxAiShadowRunResult> {
    const ordered = sortedRecords(records);
    const batchSize = Math.max(1, Math.min(200, Math.floor(options.batchSize || 25)));
    const maxCalls = Math.max(1, Math.min(batchSize, Math.floor(options.maxCalls || batchSize)));
    const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.maxAttempts || 2)));
    const timeoutMs = Math.max(100, Math.min(120_000, Math.floor(options.timeoutMs || 15_000)));
    const retryBackoffMs = Math.max(0, Math.min(30_000, Math.floor(options.retryBackoffMs || 250)));
    const sleep = options.sleep || defaultSleep;
    const cache = options.cache || new Map<string, TaxAiClassification>();
    if (checkpoint && checkpoint.inputCount !== ordered.length) {
      throw new Error("Tax-AI shadow checkpoint does not match the current input set.");
    }
    if (checkpoint?.lastProcessedId && !ordered.some((record) => record.id === checkpoint.lastProcessedId)) {
      throw new Error("Tax-AI shadow checkpoint does not match the current record IDs.");
    }
    const startIndex = checkpoint?.lastProcessedId ? ordered.findIndex((record) => record.id === checkpoint.lastProcessedId) + 1 : 0;
    const selected = ordered.slice(Math.max(0, startIndex), Math.max(0, startIndex) + batchSize);
    const results: TaxAiShadowRecordResult[] = [];
    const errors: string[] = [];
    let providerCalls = 0;
    for (const record of selected) {
      const evidenceHash = hashTaxAiEvidence(record.evidence, options.taxonomyFingerprint || "");
      const cacheKey = `${this.provider.id}:${this.provider.model}:${TAX_AI_SCHEMA_VERSION}:${evidenceHash}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        results.push({ id: record.id, evidenceHash, group: resultGroup(cached), classification: cached, attempts: 0, fromCache: true, mediaInputStatus: "not-requested" });
        continue;
      }
      if (providerCalls >= maxCalls) break;
      let raw: unknown;
      let attempts = 0;
      let lastError: unknown;
      while (attempts < maxAttempts) {
        if (providerCalls >= maxCalls) break;
        attempts += 1;
        providerCalls += 1;
        try {
          raw = await withTimeout(this.provider.classify({ evidence: record.evidence, taxonomy: this.catalog, promptVersion: TAX_AI_SCHEMA_VERSION }), timeoutMs);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempts < maxAttempts) await sleep(retryBackoffMs * (2 ** (attempts - 1)));
        }
      }
      if (lastError !== undefined || raw === undefined) {
        const classification = safeTaxAiReview("AI_PENDING", this.provider.model);
        cache.set(cacheKey, classification);
        errors.push(`${record.id}: ${lastError instanceof Error ? lastError.message : "provider unavailable"}`);
        results.push({ id: record.id, evidenceHash, group: "REVIEW", classification, attempts, fromCache: false, mediaInputStatus: this.provider.lastMediaInputStatus || "not-requested" });
        continue;
      }
      const classification = validateTaxAiModelOutput({ raw, catalog: this.catalog, evidence: record.evidence, model: this.provider.model, promptVersion: TAX_AI_SCHEMA_VERSION, minimumHighConfidence: options.minimumHighConfidence });
      cache.set(cacheKey, classification);
      results.push({ id: record.id, evidenceHash, group: resultGroup(classification), classification, attempts, fromCache: false, mediaInputStatus: this.provider.lastMediaInputStatus || "not-requested" });
    }
    const groups = emptyGroups();
    results.forEach((result) => { groups[result.group] += 1; });
    const lastProcessedId = results.length > 0 ? results[results.length - 1].id : checkpoint?.lastProcessedId || null;
    const nextIndex = lastProcessedId ? ordered.findIndex((record) => record.id === lastProcessedId) + 1 : 0;
    return Object.freeze({
      results: Object.freeze(results),
      groups: Object.freeze(groups),
      checkpoint: Object.freeze({ schemaVersion: TAX_AI_SCHEMA_VERSION, lastProcessedId, inputCount: ordered.length }),
      complete: nextIndex >= ordered.length,
      providerCalls,
      errors: Object.freeze(errors),
    });
  }
}

export function benchmarkShadowRun(
  references: Parameters<typeof benchmarkTaxAiResults>[0],
  results: readonly TaxAiShadowRecordResult[],
): TaxAiBenchmarkMetrics {
  return benchmarkTaxAiResults(references, results.map((result) => ({ id: result.id, classification: result.classification })));
}
