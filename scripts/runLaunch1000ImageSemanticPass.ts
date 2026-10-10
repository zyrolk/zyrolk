import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

import { categoryFromData, type Launch1000RawRecord } from "./runLaunch1000ImageSemanticPassSupport";
import { buildLaunch1000SemanticPass, type Launch1000ManagedImageEvidence, type Launch1000SemanticCandidate, type Launch1000SemanticResult } from "../src/services/launch1000ImageSemanticPass";
import type { Launch1000Category, Launch1000TrustedMapping } from "../src/services/launch1000TaxonomyWorkbench";

const PROJECT_ID = "zyrolk-e0164";
const OUTPUT_DIR = path.resolve(".local/launch-1000");
const INPUT_PATH = path.join(OUTPUT_DIR, "taxonomy-workbench-dry-run-v3.json");
const RULE_VERSION = "2026-10-08-r8";
const RESULT_PATH = path.join(OUTPUT_DIR, "image-semantic-results-r8.jsonl");
const CHECKPOINT_PATH = path.join(OUTPUT_DIR, "image-semantic-checkpoint-r8.json");
const REPORT_PATH = path.join(OUTPUT_DIR, "image-semantic-pass-r8.json");
const IMAGE_SAMPLE_DIR = path.join(OUTPUT_DIR, "image-samples-r8");
const IMAGE_MANIFEST_PATH = path.join(OUTPUT_DIR, "image-sample-manifest-r8.json");
const BATCH_SIZE = 100;

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return String(value ?? "").trim(); }

function managedImage(raw: Launch1000RawRecord): Launch1000ManagedImageEvidence {
  const media = Array.isArray(raw.managedMedia) ? raw.managedMedia : [];
  const primary = media.map(record).find((item) => item.isPrimary === true && item.imageStatus === "ready" && text(item.firebaseStorageUrl));
  if (!primary) return { available: false };
  const variants = record(primary.variants);
  const thumb = record(variants.thumbnail);
  const large = record(variants.large);
  return {
    available: true,
    mimeType: text(primary.mimeType || thumb.mimeType),
    width: Number(primary.width || thumb.width) || undefined,
    height: Number(primary.height || thumb.height) || undefined,
    imageUrl: text(primary.firebaseStorageUrl || thumb.storageUrl) || undefined,
    storagePath: text(large.storagePath || thumb.storagePath) || undefined,
  };
}

function enrich(candidate: Launch1000SemanticCandidate, raw: Launch1000RawRecord): Launch1000SemanticCandidate {
  return { ...candidate, managedImage: managedImage(raw) };
}

function counts(results: readonly Launch1000SemanticResult[]): Record<string, number> {
  return results.reduce<Record<string, number>>((out, result) => { out[result.classification] = (out[result.classification] || 0) + 1; return out; }, {});
}

function byField<T>(values: readonly T[], field: (value: T) => string): Array<{ value: string; count: number }> {
  const map = new Map<string, number>();
  for (const value of values) { const key = field(value); map.set(key, (map.get(key) || 0) + 1); }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

async function fetchRepresentativeManagedImages(results: readonly Launch1000SemanticResult[], rawById: ReadonlyMap<string, Launch1000RawRecord>, bucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>) {
  const selected: string[] = [];
  const seenClusters = new Set<string>();
  for (const result of [...results].sort((a, b) => a.classification.localeCompare(b.classification) || a.candidateId.localeCompare(b.candidateId))) {
    const raw = rawById.get(result.candidateId);
    const media = raw && Array.isArray(raw.managedMedia) ? raw.managedMedia : [];
    const primary = media.map(record).find((item) => item.isPrimary === true && item.imageStatus === "ready" && (text(item.firebaseStorageUrl) || text(record(item.variants).large && record(record(item.variants).large).storagePath)));
    if (!primary || seenClusters.has(result.clusterSignature)) continue;
    seenClusters.add(result.clusterSignature);
    selected.push(result.candidateId);
    if (selected.length >= 30) break;
  }
  await mkdir(IMAGE_SAMPLE_DIR, { recursive: true });
  const manifest: Array<{ candidateId: string; sku: string; title: string; file: string; fetched: boolean; error?: string }> = [];
  for (const candidateId of selected) {
    const result = results.find((item) => item.candidateId === candidateId)!;
    const raw = rawById.get(candidateId)!;
    const media = Array.isArray(raw.managedMedia) ? raw.managedMedia : [];
    const primary = media.map(record).find((item) => item.isPrimary === true && item.imageStatus === "ready" && (text(item.firebaseStorageUrl) || text(record(item.variants).large && record(record(item.variants).large).storagePath)));
    const file = path.join(IMAGE_SAMPLE_DIR, `${candidateId}.webp`);
    try {
      const variants = record(primary?.variants);
      const large = record(variants.large);
      const thumbnail = record(variants.thumbnail);
      const storagePath = text(large.storagePath || thumbnail.storagePath);
      if (!storagePath) throw new Error("managed storage path unavailable");
      const [body] = await bucket.file(storagePath).download();
      const contentType = text(large.mimeType || thumbnail.mimeType || primary?.mimeType || "image/webp");
      if (body.byteLength > 2_000_000 || !/^image\/(webp|png|jpeg)$/iu.test(contentType)) throw new Error(`unsafe managed image response: ${contentType} ${body.byteLength}`);
      await writeFile(file, body);
      manifest.push({ candidateId, sku: result.sku, title: result.title, file, fetched: true });
    } catch (error) {
      manifest.push({ candidateId, sku: result.sku, title: result.title, file, fetched: false, error: String(error) });
    }
  }
  await writeFile(IMAGE_MANIFEST_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), readOnly: true, sampleLimit: 30, manifest }, null, 2)}\n`, "utf8");
  return manifest;
}

async function main() {
  const input = JSON.parse(await readFile(INPUT_PATH, "utf8")) as { candidates: Launch1000SemanticCandidate[] };
  const app = getApps().length > 0 ? getApp() : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket("zyrolk-e0164.firebasestorage.app");
  const categorySnapshot = await db.collection("categories").get();
  const mappingSnapshot = await db.collection("supplier_category_mappings").get();
  const categories: Launch1000Category[] = categorySnapshot.docs.map((document) => categoryFromData(document.id, record(document.data())));
  const mappings = mappingSnapshot.docs.map((document) => record(document.data()) as Launch1000TrustedMapping);
  const rawById = new Map<string, Launch1000RawRecord>();
  for (let offset = 0; offset < input.candidates.length; offset += 100) {
    const ids = input.candidates.slice(offset, offset + 100).map((candidate) => candidate.id);
    const docs = await db.getAll(...ids.map((id) => db.collection("supplier_review_queue").doc(id)));
    for (const document of docs) rawById.set(document.id, document.data() as Launch1000RawRecord);
    console.error(`Launch-1000 semantic pass read ${Math.min(offset + ids.length, input.candidates.length)}/${input.candidates.length} raw records...`);
  }
  await mkdir(OUTPUT_DIR, { recursive: true });
  const existing = new Map<string, Launch1000SemanticResult>();
  try {
    const lines = (await readFile(RESULT_PATH, "utf8")).split(/\r?\n/gu).filter(Boolean);
    for (const line of lines) { const result = JSON.parse(line) as Launch1000SemanticResult; if (result.candidateId) existing.set(result.candidateId, result); }
  } catch { /* first local run */ }
  const ordered = [...input.candidates].sort((a, b) => a.id.localeCompare(b.id));
  const pending = ordered.filter((candidate) => !existing.has(candidate.id));
  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    const batch = pending.slice(offset, offset + BATCH_SIZE).map((candidate) => enrich(candidate, rawById.get(candidate.id) || {}));
    const results = buildLaunch1000SemanticPass({ candidates: batch, catalog: categories, trustedMappings: mappings });
    for (const result of results) { await appendFile(RESULT_PATH, `${JSON.stringify(result)}\n`, "utf8"); existing.set(result.candidateId, result); }
    const checkpoint = { generatedAt: new Date().toISOString(), ruleVersion: RULE_VERSION, batchSize: BATCH_SIZE, total: ordered.length, processed: existing.size, cursor: [...existing.keys()].sort().at(-1) || null, readOnly: true };
    await writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    console.error(`Launch-1000 semantic pass processed ${Math.min(offset + batch.length, pending.length)}/${pending.length} pending records...`);
  }
  const results = ordered.map((candidate) => existing.get(candidate.id)).filter((result): result is Launch1000SemanticResult => Boolean(result));
  const report = {
    generatedAt: new Date().toISOString(), projectId: PROJECT_ID, ruleVersion: RULE_VERSION, readOnly: true, batchSize: BATCH_SIZE,
    inputCount: ordered.length, rawRecordsLoaded: rawById.size, counts: counts(results),
    managedImageAvailable: results.filter((result) => result.imageEvidence[0] === "managed media provenance present").length,
    imageFetchVerified: results.filter((result) => result.imageEvidence.includes("managed image fetch verified")).length,
    visualImageEvidence: results.filter((result) => result.imageEvidence.some((item) => item !== "managed media provenance present" && item !== "managed image fetch verified" && !item.includes("not available"))).length,
    cleanReadyAfterTaxonomy: results.filter((result) => result.cleanReadyAfterTaxonomy).length,
    cleanReadyAfterSafeSpec: results.filter((result) => result.cleanReadyAfterSafeSpec).length,
    deterministicSpecNormalization: results.filter((result) => result.specDisposition === "DETERMINISTIC_SPEC_NORMALIZATION").length,
    postTaxonomyBlockers: byField(results.flatMap((result) => result.postTaxonomyBlockers), (item) => item),
    clusterCount: new Set(results.map((result) => `${result.classification}:${result.clusterSignature}:${result.categoryId || ""}:${result.subcategoryId || ""}`)).size,
    imageSamples: [] as Array<{ candidateId: string; sku: string; title: string; file: string; fetched: boolean; error?: string }>,
    results,
  };
  const imageSamples = await fetchRepresentativeManagedImages(results, rawById, bucket);
  const fetchedIds = new Set(imageSamples.filter((item) => item.fetched).map((item) => item.candidateId));
  for (const result of results) if (fetchedIds.has(result.candidateId) && !result.imageEvidence.includes("managed image fetch verified")) result.imageEvidence.push("managed image fetch verified");
  report.imageFetchVerified = fetchedIds.size;
  report.imageSamples = imageSamples;
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ inputCount: ordered.length, counts: report.counts, managedImageAvailable: report.managedImageAvailable, cleanReadyAfterTaxonomy: report.cleanReadyAfterTaxonomy, cleanReadyAfterSafeSpec: report.cleanReadyAfterSafeSpec, deterministicSpecNormalization: report.deterministicSpecNormalization, clusterCount: report.clusterCount, imageSamplesFetched: imageSamples.filter((item) => item.fetched).length, reportPath: REPORT_PATH }, null, 2));
}

await main();
