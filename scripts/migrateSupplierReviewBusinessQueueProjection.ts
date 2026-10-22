import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import appletConfig from "../firebase-applet-config.json";
import {
  buildSupplierReviewBusinessQueueProjection,
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
import {
  canResumeSupplierReviewBusinessProjectionMigration,
  migrationModeFor,
  projectionPatchRequiresWrite,
  supplierReviewProjectionSourceFingerprint,
  SupplierReviewBusinessProjectionMigrationMode,
} from "./supplierReviewBusinessQueueProjectionMigrationSupport";

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

const categoryRequirementsCache = new Map<string, boolean>();

async function loadCategoryRequirements(categoryIds: Iterable<string>): Promise<Map<string, boolean>> {
  const ids = [...new Set([...categoryIds].map((id) => String(id || "").trim()).filter(Boolean))];
  const missingIds = ids.filter((id) => !categoryRequirementsCache.has(id));
  if (missingIds.length === 0) return categoryRequirementsCache;

  const documents = await db.getAll(...missingIds.map((id) => db.collection("categories").doc(id)));
  documents.forEach((document) => {
    const data = document.data() || {};
    const subcategories = Array.isArray(data.subcategories) ? data.subcategories : [];
    const hasActiveSubcategory = subcategories.some((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).isActive !== false
    ));
    categoryRequirementsCache.set(
      document.id,
      data.isActive === true && data.taxonomyCandidate !== true && hasActiveSubcategory,
    );
  });
  return categoryRequirementsCache;
}

interface MigrationSummary {
  scanned: number;
  requiringProjection: number;
  projected: number;
  conflicts: number;
  conflictIds: string[];
  lastDocumentId: string | null;
}

const categoryRequiresSubcategoryFor = (data: Record<string, unknown>): boolean => {
  const subcategories = Array.isArray(data.subcategories) ? data.subcategories : [];
  return data.isActive === true
    && data.taxonomyCandidate !== true
    && subcategories.some((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).isActive !== false
    ));
};

interface ProjectionPageFenceResult {
  scanned: number;
  projected: number;
  checkpoint: string | null;
  conflictIds: string[];
}

const applyProjectionPageWithConcurrencyFence = async (
  snapshot: FirebaseFirestore.QuerySnapshot,
  pending: Array<{ document: FirebaseFirestore.QueryDocumentSnapshot; projection: Record<string, unknown> }>,
  categoryRequirements: Map<string, boolean>,
  previousCheckpoint: string | null,
  migrationMode: SupplierReviewBusinessProjectionMigrationMode,
  summary: Pick<MigrationSummary, "scanned" | "projected">,
): Promise<ProjectionPageFenceResult> => db.runTransaction(async (transaction) => {
  // Read every queue and referenced category document in the same transaction
  // before writing any projection or checkpoint fields.
  const currentQueueSnapshots = await Promise.all(snapshot.docs.map((document) => transaction.get(document.ref)));
  const categoryIds = [...new Set(snapshot.docs.map((document) => categoryIdFor(document.data() as SupplierQueueRecord)).filter(Boolean))];
  const currentCategorySnapshots = await Promise.all(categoryIds.map((categoryId) => (
    transaction.get(db.collection("categories").doc(categoryId))
  )));
  const currentCategoryById = new Map(categoryIds.map((categoryId, index) => [categoryId, currentCategorySnapshots[index]]));
  const conflictSet = new Set<string>();

  snapshot.docs.forEach((document, index) => {
    const current = currentQueueSnapshots[index];
    if (!current.exists || supplierReviewProjectionSourceFingerprint(document.data())
      !== supplierReviewProjectionSourceFingerprint(current.data() || {})) {
      conflictSet.add(document.id);
    }
  });
  snapshot.docs.forEach((document) => {
    const categoryId = categoryIdFor(document.data() as SupplierQueueRecord);
    if (!categoryId) return;
    const currentCategory = currentCategoryById.get(categoryId);
    const currentRequirement = currentCategory?.exists
      ? categoryRequiresSubcategoryFor(currentCategory.data() || {})
      : false;
    if (currentRequirement !== (categoryRequirements.get(categoryId) === true)) conflictSet.add(document.id);
  });

  const firstConflictIndex = snapshot.docs.findIndex((document) => conflictSet.has(document.id));
  const safeCount = firstConflictIndex < 0 ? snapshot.size : firstConflictIndex;
  const safePending = pending.filter(({ document }) => snapshot.docs.indexOf(document) < safeCount);
  safePending.forEach(({ document, projection }) => transaction.set(document.ref, projection, { merge: true }));
  const checkpoint = safeCount > 0 ? snapshot.docs[safeCount - 1].id : previousCheckpoint;
  const nextSummary = {
    scanned: summary.scanned + safeCount,
    projected: summary.projected + safePending.length,
  };
  transaction.set(metadataReference, {
    status: "pending",
    version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
    migrationMode,
    scanned: nextSummary.scanned,
    projected: nextSummary.projected,
    lastDocumentId: checkpoint,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return {
    scanned: safeCount,
    projected: safePending.length,
    checkpoint,
    conflictIds: snapshot.docs.filter((document) => conflictSet.has(document.id)).map((document) => document.id),
  };
});

async function migrate(): Promise<void> {
  const existingMetadata = await supplierReviewBusinessProjectionReference(db).get();
  const existing = existingMetadata.exists ? existingMetadata.data() as Record<string, unknown> : {};
  const initialMigrationRequired = isSupplierReviewBusinessProjectionMigrationRequired(existing);
  const legacyRecordsPresent = initialMigrationRequired
    ? false
    : !(await db.collection("supplier_review_queue")
      .where("businessQueueClassesVersion", "!=", SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION)
      .limit(1)
      .get()).empty;
  const detectedMigrationMode: SupplierReviewBusinessProjectionMigrationMode = migrationModeFor(
    existing,
    legacyRecordsPresent,
  );

  const markerIsActive = existing.status === "active"
    && existing.version === SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION;
  // An active marker fences indexed reads, but it does not prove that every
  // v4 record still matches current canonical category requirements. Active
  // markers therefore receive a bounded repair scan; a clean scan remains a
  // true no-op with no metadata or queue writes.
  if (detectedMigrationMode === "noop" && !markerIsActive) {
    console.info(JSON.stringify({
      mode: "already-active",
      legacyRecordsPresent: false,
      projectId: expectedProjectId,
      ...existing,
    }));
    return;
  }

  const checkpoint = migrationCheckpointForProjectionVersion(existing);
  const summary: MigrationSummary = {
    scanned: checkpoint.scanned,
    requiringProjection: 0,
    projected: checkpoint.projected,
    conflicts: 0,
    conflictIds: [],
    lastDocumentId: checkpoint.lastDocumentId,
  };
  let lastDocumentId = summary.lastDocumentId;
  let batchCount = 0;
  let complete = false;

  const canResumeExistingCheckpoint = canResumeSupplierReviewBusinessProjectionMigration(existing);
  let migrationMode: SupplierReviewBusinessProjectionMigrationMode = canResumeExistingCheckpoint
    && existing.migrationMode === "mixed-version-repair"
    ? "mixed-version-repair"
    : markerIsActive ? "mixed-version-repair" : detectedMigrationMode;
  let migrationStarted = canResumeExistingCheckpoint;
  if (applyRequested && !canResumeExistingCheckpoint) {
    await metadataReference.set({
      status: "pending",
      version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
      migrationMode,
      scanned: 0,
      projected: 0,
      lastDocumentId: null,
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    migrationStarted = true;
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

    const categoryRequirements = await loadCategoryRequirements(
      snapshot.docs.map((document) => categoryIdFor(document.data() as SupplierQueueRecord)),
    );
    const pending = snapshot.docs.map((document) => {
      const record = document.data() as SupplierQueueRecord;
      const projection = buildSupplierReviewBusinessQueueProjection(
        record,
        categoryRequirements.get(categoryIdFor(record)) === true,
      );
      return { document, projection };
    }).filter(({ document, projection }) => projectionPatchRequiresWrite(document.data(), projection));

    summary.requiringProjection += pending.length;

    if (applyRequested) {
      const shouldFencePage = migrationStarted || pending.length > 0;
      if (shouldFencePage) {
        const result = await applyProjectionPageWithConcurrencyFence(
          snapshot,
          pending,
          categoryRequirements,
          lastDocumentId,
          migrationMode,
          summary,
        );
        migrationStarted = true;
        summary.scanned += result.scanned;
        summary.projected += result.projected;
        summary.lastDocumentId = result.checkpoint;
        lastDocumentId = result.checkpoint;
        summary.conflicts += result.conflictIds.length;
        summary.conflictIds = [...new Set([...summary.conflictIds, ...result.conflictIds])].slice(0, 100);
        if (result.conflictIds.length > 0) {
          complete = false;
          break;
        }
      } else {
        // Active v4 with no repair candidates is a read-only no-op. Do not
        // write a checkpoint merely because the bounded verification scanned
        // another page.
        summary.scanned += snapshot.size;
        summary.lastDocumentId = snapshot.docs.at(-1)?.id || summary.lastDocumentId;
        lastDocumentId = summary.lastDocumentId;
      }
    } else {
      summary.scanned += snapshot.size;
      summary.lastDocumentId = snapshot.docs.at(-1)?.id || summary.lastDocumentId;
      lastDocumentId = summary.lastDocumentId;
    }

    if (snapshot.size < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (applyRequested && complete && migrationStarted) {
    await metadataReference.set({
      status: "active",
      version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
      migrationMode: FieldValue.delete(),
      scanned: summary.scanned,
      projected: summary.projected,
      lastDocumentId: null,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } else if (applyRequested && migrationStarted) {
    await metadataReference.set({
      status: "pending",
      version: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
      migrationMode,
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
    migrationMode,
    legacyRecordsPresent,
    projectionVersion: SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
    businessQueueClassesVersion: SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_VERSION,
    ...summary,
    guarantees: [
      "projection-field-only",
      "bounded-page-size-200",
      "checkpointed-resume",
      "idempotent-merge-writes",
      "mixed-version-repair",
      "dry-run-no-metadata-writes",
      "category-reads-by-referenced-id",
      "no-supplier-sync",
      "no-product-business-data-rewrite",
    ],
  }));
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Supplier business queue projection migration failed.");
  process.exitCode = 1;
});
