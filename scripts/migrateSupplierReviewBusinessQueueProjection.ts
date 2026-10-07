import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import appletConfig from "../firebase-applet-config.json";
import {
  buildSupplierReviewBusinessQueueProjection,
  SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_FIELD,
  SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_VERSION,
  SupplierQueueRecord,
} from "../functions/src/scheduled/supplierReviewQueue";
import {
  SUPPLIER_REVIEW_BUSINESS_PROJECTION_COLLECTION,
  SUPPLIER_REVIEW_BUSINESS_PROJECTION_DOCUMENT,
  SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
  isSupplierReviewBusinessProjectionMigrationRequired,
  migrationCheckpointForProjectionVersion,
  supplierReviewBusinessProjectionReference,
} from "../functions/src/api/suppliers/supplierReviewBusinessQueueProjection";

const applyRequested = process.argv.includes("--apply");
const expectedProjectId = String(appletConfig.projectId || "").trim();
const confirmationVariable = "SUPPLIER_REVIEW_BUSINESS_PROJECTION_CONFIRM";
const PAGE_SIZE = 200;
const MAX_BATCHES_PER_INVOCATION = 25;

if (!expectedProjectId) throw new Error("firebase-applet-config.json does not contain a projectId.");
if (applyRequested && process.env[confirmationVariable] !== expectedProjectId) {
  throw new Error(`Set ${confirmationVariable}=${expectedProjectId} to authorize the supplier business queue projection migration.`);
}

const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: expectedProjectId });
const db = getFirestore(app);
const metadataReference = db.collection(SUPPLIER_REVIEW_BUSINESS_PROJECTION_COLLECTION)
  .doc(SUPPLIER_REVIEW_BUSINESS_PROJECTION_DOCUMENT);

const categoryIdFor = (record: SupplierQueueRecord): string => {
  const payload = record.productPayload && typeof record.productPayload === "object" && !Array.isArray(record.productPayload)
    ? record.productPayload as Record<string, unknown>
    : {};
  return String(payload.category || "").trim();
};

async function loadCategoryRequirements(): Promise<Map<string, boolean>> {
  const snapshot = await db.collection("categories").get();
  return new Map(snapshot.docs.map((document) => {
    const data = document.data() || {};
    const subcategories = Array.isArray(data.subcategories) ? data.subcategories : [];
    const hasActiveSubcategory = subcategories.some((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).isActive !== false
    ));
    return [
      document.id,
      data.isActive === true && data.taxonomyCandidate !== true && hasActiveSubcategory,
    ] as const;
  }));
}

interface MigrationSummary {
  scanned: number;
  requiringProjection: number;
  projected: number;
  lastDocumentId: string | null;
}

const projectionNeedsWrite = (record: Record<string, unknown>, patch: Record<string, unknown>): boolean => (
  JSON.stringify(record[SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_FIELD] || [])
    !== JSON.stringify(patch[SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_FIELD] || [])
    || record.businessQueueClassesVersion !== patch.businessQueueClassesVersion
);

async function migrate(): Promise<void> {
  const existingMetadata = await supplierReviewBusinessProjectionReference(db).get();
  const existing = existingMetadata.exists ? existingMetadata.data() as Record<string, unknown> : {};
  if (!isSupplierReviewBusinessProjectionMigrationRequired(existing)) {
    console.info(JSON.stringify({ mode: "already-active", projectId: expectedProjectId, ...existing }));
    return;
  }

  const categoryRequirements = await loadCategoryRequirements();
  const checkpoint = migrationCheckpointForProjectionVersion(existing);
  const summary: MigrationSummary = {
    scanned: checkpoint.scanned,
    requiringProjection: 0,
    projected: checkpoint.projected,
    lastDocumentId: checkpoint.lastDocumentId,
  };
  let lastDocumentId = summary.lastDocumentId;
  let batchCount = 0;
  let complete = false;

  const canResumeExistingCheckpoint = existing.status === "pending"
    && existing.version === SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION;
  if (applyRequested && !canResumeExistingCheckpoint) {
    await metadataReference.set({
      status: "pending",
      version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
      scanned: 0,
      projected: 0,
      lastDocumentId: null,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  while (batchCount < MAX_BATCHES_PER_INVOCATION) {
    batchCount += 1;
    let query = db.collection("supplier_review_queue")
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDocumentId) query = query.startAfter(lastDocumentId);
    const snapshot = await query.get();
    if (snapshot.empty) {
      complete = true;
      break;
    }

    const pending = snapshot.docs.map((document) => {
      const record = document.data() as SupplierQueueRecord;
      const projection = buildSupplierReviewBusinessQueueProjection(
        record,
        categoryRequirements.get(categoryIdFor(record)) === true,
      );
      return { document, projection };
    }).filter(({ document, projection }) => projectionNeedsWrite(document.data(), projection));

    summary.scanned += snapshot.size;
    summary.requiringProjection += pending.length;
    lastDocumentId = snapshot.docs.at(-1)?.id || lastDocumentId;
    summary.lastDocumentId = lastDocumentId;

    if (applyRequested) {
      const batch = db.batch();
      pending.forEach(({ document, projection }) => batch.set(document.ref, projection, { merge: true }));
      summary.projected += pending.length;
      batch.set(metadataReference, {
        status: "pending",
        version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
        scanned: summary.scanned,
        projected: summary.projected,
        lastDocumentId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
    }

    if (snapshot.size < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (applyRequested && complete) {
    await metadataReference.set({
      status: "active",
      version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
      scanned: summary.scanned,
      projected: summary.projected,
      lastDocumentId: null,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } else if (applyRequested) {
    await metadataReference.set({
      status: "pending",
      version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
      scanned: summary.scanned,
      projected: summary.projected,
      lastDocumentId: summary.lastDocumentId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  console.info(JSON.stringify({
    mode: applyRequested ? "apply" : "dry-run",
    projectId: expectedProjectId,
    complete,
    batchCount,
    maxBatchesPerInvocation: MAX_BATCHES_PER_INVOCATION,
    pageSize: PAGE_SIZE,
    projectionVersion: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
    businessQueueClassesVersion: SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_VERSION,
    ...summary,
    guarantees: [
      "projection-field-only",
      "bounded-page-size-200",
      "checkpointed-resume",
      "idempotent-merge-writes",
      "no-supplier-sync",
      "no-product-business-data-rewrite",
    ],
  }));
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Supplier business queue projection migration failed.");
  process.exitCode = 1;
});
