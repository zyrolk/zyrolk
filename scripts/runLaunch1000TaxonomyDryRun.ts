import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";

import {
  buildLaunch1000Workbench,
  type Launch1000Candidate,
  type Launch1000Category,
  type Launch1000TrustedMapping,
} from "../src/services/launch1000TaxonomyWorkbench";
import {
  supplierReviewRecordHasPublicationReadyMedia,
  reviewRecordIsTerminalDecision,
  type SupplierQueueRecord,
} from "../functions/src/scheduled/supplierReviewQueue";

const PROJECT_ID = "zyrolk-e0164";
const OUTPUT_DIR = path.resolve(".local/launch-1000");
const STOCK_THRESHOLD = 4;

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstText(...values: unknown[]): string {
  return values.map(text).find(Boolean) || "";
}

function arrayText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const entry = record(item);
    return [text(entry.name || entry.value || entry.label)].filter(Boolean);
  });
}

function categoryFromData(id: string, value: AnyRecord): Launch1000Category {
  const subcategories = Array.isArray(value.subcategories)
    ? value.subcategories.map((item) => {
      const entry = record(item);
      return { id: text(entry.id), name: text(entry.name), isActive: entry.isActive !== false };
    }).filter((item) => item.id && item.name)
    : [];
  const specificationTemplate = Array.isArray(value.specificationTemplate)
    ? value.specificationTemplate.map((item) => {
      const entry = record(item);
      return { name: text(entry.name), required: entry.required === true };
    }).filter((item) => item.name)
    : [];
  return {
    id,
    name: text(value.name || id),
    isActive: value.isActive === true,
    taxonomyCandidate: value.taxonomyCandidate === true,
    subcategories,
    specificationTemplate,
    keywords: arrayText(value.keywords),
  };
}

function supplierTaxonomyValues(payload: AnyRecord, snapshot: AnyRecord, mapping: AnyRecord): string[] {
  return [...new Set([
    payload.supplierCategory,
    payload.supplierTaxonomy,
    record(payload.supplierMetadata).supplierCategory,
    record(payload.supplierMetadata).supplierTaxonomy,
    snapshot.supplierCategory,
    snapshot.supplierTaxonomy,
    mapping.supplierCategory,
  ].flatMap((value) => Array.isArray(value) ? value.map(text) : [text(value)]).filter(Boolean))];
}

function comparisonIsLive(recordValue: AnyRecord): boolean {
  const comparison = record(recordValue.comparison);
  const baseline = record(recordValue.approvalBaseline);
  return comparison.matchedProductLive === true
    || comparison.matchFound === true
    || baseline.exists === true
    || Boolean(text(recordValue.matchedProductId)) && text(comparison.comparisonStatus || recordValue.comparisonStatus) !== "new_product";
}

function isNewUnpublished(recordValue: AnyRecord): boolean {
  if (comparisonIsLive(recordValue)) return false;
  const comparison = record(recordValue.comparison);
  const status = text(comparison.comparisonStatus || recordValue.comparisonStatus).toLowerCase();
  return status === "new_product" || status === "new" || (!text(recordValue.matchedProductId) && comparison.matchFound !== true);
}

function currentTaxonomyIsValid(payload: AnyRecord, categories: readonly Launch1000Category[]): boolean {
  const categoryId = text(payload.category);
  const subcategoryId = text(payload.subcategory);
  const category = categories.find((item) => item.id === categoryId && item.isActive === true && item.taxonomyCandidate !== true);
  if (!category) return false;
  const activeSubcategories = (category.subcategories || []).filter((item) => item.isActive !== false);
  return activeSubcategories.length === 0 || activeSubcategories.some((item) => item.id === subcategoryId);
}

function rawNonTaxonomyBlockers(recordValue: AnyRecord, payload: AnyRecord, mediaReady: boolean, attributionValid: boolean): string[] {
  const blockers = new Set<string>();
  if (!firstText(payload.name, payload.title, recordValue.productName)) blockers.add("TITLE_REQUIRED");
  if (!firstText(payload.description)) blockers.add("DESCRIPTION_REQUIRED");
  if ((numberOrNull(payload.price ?? payload.sellingPrice) ?? 0) <= 0) blockers.add("INVALID_PRICE");
  const stock = numberOrNull(recordValue.stock ?? payload.stock ?? record(recordValue.supplierSnapshot).inventoryLevel);
  if (!Number.isInteger(stock) || (stock ?? -1) < 0) blockers.add("INVALID_STOCK");
  if ((stock ?? 0) < STOCK_THRESHOLD) blockers.add("LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  if (!mediaReady) blockers.add("MEDIA_NOT_READY");
  if (!attributionValid) blockers.add("INVALID_ATTRIBUTION");
  const validation = record(recordValue.productValidation);
  const errors = Array.isArray(validation.errors) ? validation.errors : [];
  const missing = Array.isArray(validation.missingFields) ? validation.missingFields : [];
  for (const error of errors) {
    const entry = record(error);
    const field = text(entry.field).toLowerCase();
    const code = text(entry.code).toUpperCase();
    if (!field.includes("categor") && !field.includes("subcategor") && !code.includes("CATEGOR")) blockers.add(code || field || "VALIDATION_ERROR");
  }
  for (const field of missing.map(text)) {
    if (!field.toLowerCase().includes("categor")) blockers.add(field.toUpperCase());
  }
  return [...blockers];
}

function toCandidate(id: string, raw: AnyRecord, categories: readonly Launch1000Category[]): Launch1000Candidate | null {
  const sourceId = text(raw.sourceId).toLowerCase();
  if (sourceId !== "dropex" || reviewRecordIsTerminalDecision(raw as SupplierQueueRecord) || !isNewUnpublished(raw)) return null;
  const payload = record(raw.productPayload);
  const snapshot = record(raw.supplierSnapshot);
  const mapping = record(raw.categoryMapping);
  const mediaReady = supplierReviewRecordHasPublicationReadyMedia(raw as SupplierQueueRecord);
  const stock = numberOrNull(raw.stock ?? payload.stock ?? snapshot.inventoryLevel);
  const price = numberOrNull(payload.price ?? payload.sellingPrice);
  const supplierId = firstText(record(payload.supplierMetadata).supplierId, record(payload.supplierMetadata).supplierCode, raw.supplierCode, raw.sourceId);
  const title = firstText(payload.name, payload.title, raw.productName);
  const description = firstText(payload.description, snapshot.description);
  const policyText = `${title} ${description} ${supplierTaxonomyValues(payload, snapshot, mapping).join(" ")}`.toLowerCase();
  const policyHold = /\b(knife|knives|blade|sword|weapon|medicine|drug|pesticide|vape|tobacco|adult|counterfeit|replica)\b/iu.test(policyText);
  const attributionValid = Boolean(supplierId);
  const otherBlockers = rawNonTaxonomyBlockers(raw, payload, mediaReady, attributionValid);
  const currentCategoryValid = currentTaxonomyIsValid(payload, categories);
  if (currentCategoryValid || otherBlockers.length > 0 || !Number.isInteger(stock) || (stock ?? 0) < STOCK_THRESHOLD || !mediaReady || policyHold) return null;
  const specificationSource = payload.specs || payload.specifications || snapshot.specs || record(snapshot.supplierMetadata).specifications;
  return {
    id,
    sourceId,
    sku: firstText(payload.sku, payload.supplierSku, raw.supplierSku, raw.productId, id),
    title,
    description,
    productType: firstText(payload.productType, payload.type, record(payload.supplierMetadata).productType),
    features: arrayText(payload.features || payload.tags || record(payload.supplierMetadata).features),
    specifications: record(specificationSource),
    brand: firstText(payload.brand, payload.brandName),
    supplierTaxonomy: supplierTaxonomyValues(payload, snapshot, mapping),
    stock,
    price,
    mediaReady,
    supplierAttributionValid: attributionValid,
    liveEquivalent: false,
    terminal: false,
    policyHold: false,
    currentCategoryId: text(payload.category) || null,
    currentSubcategoryId: text(payload.subcategory) || null,
    otherBlockers: [],
  };
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}

async function main() {
  const app = getApps().length > 0 ? getApp() : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore(app);
  const [categorySnapshot, mappingSnapshot] = await Promise.all([
    db.collection("categories").get(),
    db.collection("supplier_category_mappings").get(),
  ]);
  const queueDocuments: QueryDocumentSnapshot[] = [];
  let lastDocumentId: string | null = null;
  do {
    let query = db.collection("supplier_review_queue").orderBy(FieldPath.documentId()).limit(100);
    if (lastDocumentId) query = query.startAfter(lastDocumentId);
    const page = await query.get();
    queueDocuments.push(...page.docs);
    lastDocumentId = page.docs.at(-1)?.id || null;
    if (page.size > 0) console.error(`Launch-1000 dry run read ${queueDocuments.length} queue records...`);
    if (page.size < 100) break;
  } while (lastDocumentId);
  const categories = categorySnapshot.docs.map((document) => categoryFromData(document.id, record(document.data())));
  const trustedMappings: Launch1000TrustedMapping[] = mappingSnapshot.docs.map((document) => record(document.data()) as Launch1000TrustedMapping);
  const candidates = queueDocuments.map((document) => toCandidate(document.id, record(document.data()), categories)).filter((candidate): candidate is Launch1000Candidate => Boolean(candidate));
  const result = buildLaunch1000Workbench({ candidates, catalog: categories, trustedMappings });
  const outcomeCounts = countBy(result.candidates.map((candidate) => candidate.resolution.outcome));
  const cleanUnlocks = result.candidates.filter((candidate) => candidate.simulation.wouldPassPublication && candidate.resolution.outcome !== "POLICY_HOLD");
  const categoryOnlyCount = candidates.length;
  const currentReady = 30;
  const clusters = result.clusters.filter((cluster) => cluster.expectedReadyUnlockCount > 0);
  const paths: Record<string, { clusters: string[]; products: number; totalReady: number }> = {};
  for (const target of [100, 250, 500, 759, 850]) {
    let products = 0;
    const selected: string[] = [];
    for (const cluster of clusters) {
      if (currentReady + products >= target) break;
      selected.push(cluster.clusterId);
      products += cluster.expectedReadyUnlockCount;
    }
    paths[`plus${target}`] = { clusters: selected, products, totalReady: currentReady + products };
  }
  const report = {
    generatedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    readOnly: true,
    source: { queueCollection: "supplier_review_queue", sourceId: "dropex", categoryCollection: "categories", mappingCollection: "supplier_category_mappings" },
    counts: {
      queueTotal: queueDocuments.length,
      queueDropex: queueDocuments.filter((document) => text(record(document.data()).sourceId).toLowerCase() === "dropex").length,
      verifiedCategoryOnlyInput: categoryOnlyCount,
      cleanReadyUnlocks: cleanUnlocks.length,
      outcomeCounts,
      clusterCount: result.clusters.length,
      activeTaxonomyDocuments: categories.filter((category) => category.isActive && !category.taxonomyCandidate).length,
    },
    paths,
    top20Clusters: result.clusters.slice(0, 20),
    candidates: result.candidates,
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, "taxonomy-workbench-dry-run.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    verifiedCategoryOnlyInput: categoryOnlyCount,
    cleanReadyUnlocks: cleanUnlocks.length,
    outcomeCounts,
    clusterCount: result.clusters.length,
    top20: result.clusters.slice(0, 20).map((cluster) => ({ clusterId: cluster.clusterId, count: cluster.candidateCount, unlocks: cluster.expectedReadyUnlockCount, outcome: cluster.outcome, category: cluster.proposedCategoryId, subcategory: cluster.proposedSubcategoryId })),
    paths,
    reportPath: path.join(OUTPUT_DIR, "taxonomy-workbench-dry-run.json"),
  }, null, 2));
}

await main();
