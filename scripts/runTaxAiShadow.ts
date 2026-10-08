import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  TaxAiShadowRunner,
  type TaxAiShadowCheckpoint,
  type TaxAiShadowRecord,
} from "../functions/src/api/ai/taxAiShadowRunner";
import { GeminiTaxAiProvider, UnavailableTaxAiProvider } from "../functions/src/api/ai/taxAiProvider";
import type { TaxAiTaxonomyCatalog } from "../functions/src/api/ai/taxAiFoundation";

interface ShadowInputFile {
  readonly taxonomy: TaxAiTaxonomyCatalog;
  readonly records: readonly TaxAiShadowRecord[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as T;
}

function providerFromArguments(): GeminiTaxAiProvider | UnavailableTaxAiProvider {
  if (argument("--provider") !== "gemini") return new UnavailableTaxAiProvider();
  const apiKey = process.env.TAX_AI_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("--provider gemini requires TAX_AI_GEMINI_API_KEY or GEMINI_API_KEY in the local environment.");
  return new GeminiTaxAiProvider({ apiKey, model: argument("--model") || "gemini-2.5-flash" });
}

const inputPath = requiredArgument("--input");
const outputPath = requiredArgument("--output");
const checkpointPath = argument("--checkpoint");
const input = readJson<ShadowInputFile>(inputPath);
const checkpoint = checkpointPath ? readJson<TaxAiShadowCheckpoint>(checkpointPath) : null;
const provider = providerFromArguments();
const runner = new TaxAiShadowRunner(provider, input.taxonomy);
const result = await runner.run(input.records, checkpoint, {
  batchSize: Number(argument("--batch-size") || 25),
  maxCalls: Number(argument("--max-calls") || 25),
  maxAttempts: Number(argument("--max-attempts") || 2),
  timeoutMs: Number(argument("--timeout-ms") || 15_000),
});

const output = {
  generatedAt: new Date().toISOString(),
  provider: { id: provider.id, model: provider.model },
  schemaVersion: "tax-ai-1",
  ...result,
};
writeFileSync(path.resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, "utf8");
if (checkpointPath) writeFileSync(path.resolve(checkpointPath), `${JSON.stringify(result.checkpoint, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ provider: output.provider, groups: result.groups, complete: result.complete, providerCalls: result.providerCalls }, null, 2));
