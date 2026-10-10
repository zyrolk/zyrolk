import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = "zyrolk-e0164";
const OUTPUT = path.resolve(".local/launch-1000/final-pool-source-read.json");
const WORKBENCH = path.resolve(".local/launch-1000/taxonomy-workbench-dry-run.json");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return String(value ?? "").trim(); }
function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function summarizeMedia(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const entry = record(item);
    const variants = record(entry.variants);
    const large = record(variants.large);
    const thumbnail = record(variants.thumbnail);
    return {
      isPrimary: entry.isPrimary === true,
      imageStatus: text(entry.imageStatus),
      mimeType: text(entry.mimeType || large.mimeType || thumbnail.mimeType),
      width: numberOrNull(entry.width || large.width || thumbnail.width),
      height: numberOrNull(entry.height || large.height || thumbnail.height),
      firebaseStorageUrl: text(entry.firebaseStorageUrl || thumbnail.storageUrl),
      largeStoragePath: text(large.storagePath),
      thumbnailStoragePath: text(thumbnail.storagePath),
      sourceUrl: text(entry.sourceUrl),
      provenance: text(entry.provenance || entry.source),
    };
  });
}

const workbench = JSON.parse(await (await import("node:fs/promises")).readFile(WORKBENCH, "utf8")) as { candidates: Array<{ id: string }> };
const app = getApps().length > 0 ? getApp() : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore(app);
const [categorySnapshot, mappingSnapshot] = await Promise.all([
  db.collection("categories").get(),
  db.collection("supplier_category_mappings").get(),
]);
const rawRecords: Record<string, unknown>[] = [];
for (let offset = 0; offset < workbench.candidates.length; offset += 100) {
  const ids = workbench.candidates.slice(offset, offset + 100).map((candidate) => candidate.id);
  const docs = await db.getAll(...ids.map((id) => db.collection("supplier_review_queue").doc(id)));
  for (const document of docs) {
    const value = record(document.data());
    const payload = record(value.productPayload);
    const snapshot = record(value.supplierSnapshot);
    rawRecords.push({
      id: document.id,
      sourceId: text(value.sourceId),
      supplierCode: text(value.supplierCode),
      supplierSku: text(value.supplierSku || payload.sku || payload.supplierSku),
      productName: text(value.productName || payload.name || payload.title),
      stock: numberOrNull(value.stock ?? payload.stock ?? snapshot.inventoryLevel),
      productPayload: payload,
      supplierSnapshot: snapshot,
      categoryMapping: record(value.categoryMapping),
      managedMedia: value.managedMedia,
      managedMediaSummary: summarizeMedia(value.managedMedia),
      mediaSourceImageUrls: value.mediaSourceImageUrls,
      mediaStatus: text(value.mediaStatus),
      mediaQueueClass: text(value.mediaQueueClass),
      mediaFailures: value.mediaFailures,
      queueState: text(value.queueState),
      status: text(value.status),
      reviewStatus: text(value.reviewStatus),
      comparison: record(value.comparison),
      approvalBaseline: record(value.approvalBaseline),
      matchedProductId: text(value.matchedProductId),
      productValidation: value.productValidation,
      createdAt: value.createdAt,
    });
  }
  console.error(`Final pool source read ${Math.min(offset + ids.length, workbench.candidates.length)}/${workbench.candidates.length}`);
}
const report = {
  generatedAt: new Date().toISOString(),
  projectId: PROJECT_ID,
  readOnly: true,
  source: { categories: "categories", mappings: "supplier_category_mappings", queue: "supplier_review_queue" },
  categories: categorySnapshot.docs.map((document) => ({ id: document.id, data: document.data() })),
  trustedMappings: mappingSnapshot.docs.map((document) => ({ id: document.id, data: document.data() })),
  rawRecords,
};
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: OUTPUT, categoryDocuments: report.categories.length, mappingDocuments: report.trustedMappings.length, queueRecords: rawRecords.length }, null, 2));
