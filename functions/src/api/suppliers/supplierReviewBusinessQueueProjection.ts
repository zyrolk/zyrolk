import type { Firestore } from "firebase-admin/firestore";

export const SUPPLIER_REVIEW_BUSINESS_PROJECTION_COLLECTION = "supplier_read_model_meta";
export const SUPPLIER_REVIEW_BUSINESS_PROJECTION_DOCUMENT = "supplier_review_queue_business_projection";
/**
 * The marker version is the activation fence for the persisted business queue
 * classes.  It must move with the class schema so an older active marker can
 * never authorize a newer indexed query contract.
 */
export const SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION = 4;

export interface SupplierReviewBusinessProjectionStatus {
  status: "pending" | "active";
  version: number;
  scanned: number;
  projected: number;
  lastDocumentId: string | null;
  startedAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
}

export interface SupplierReviewBusinessProjectionReadiness {
  markerActive: boolean;
  indexedReadsAllowed: boolean;
  compatibilityKnown: boolean;
}

export const supplierReviewBusinessProjectionReference = (db: Firestore) => (
  db.collection(SUPPLIER_REVIEW_BUSINESS_PROJECTION_COLLECTION)
    .doc(SUPPLIER_REVIEW_BUSINESS_PROJECTION_DOCUMENT)
);

export const isSupplierReviewBusinessProjectionStatusActive = (
  data: Partial<SupplierReviewBusinessProjectionStatus> | null | undefined,
  requiredVersion = SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION,
): boolean => (
  data?.status === "active" && data.version === requiredVersion
);

export const isSupplierReviewBusinessProjectionMigrationRequired = (
  data: Partial<SupplierReviewBusinessProjectionStatus> | null | undefined,
): boolean => !isSupplierReviewBusinessProjectionStatusActive(data);

export const migrationCheckpointForProjectionVersion = (
  data: Partial<SupplierReviewBusinessProjectionStatus> | null | undefined,
): Pick<SupplierReviewBusinessProjectionStatus, "scanned" | "projected" | "lastDocumentId"> => {
  if (data?.version !== SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION || data.status !== "pending") {
    return { scanned: 0, projected: 0, lastDocumentId: null };
  }
  return {
    scanned: Number(data.scanned || 0),
    projected: Number(data.projected || 0),
    lastDocumentId: typeof data.lastDocumentId === "string" ? data.lastDocumentId : null,
  };
};

/**
 * Business queue indexes remain disabled until every existing record has the
 * same projection version. This preserves legacy behavior during deployment.
 */
export async function isSupplierReviewBusinessProjectionActive(db: Firestore): Promise<boolean> {
  const readiness = await readSupplierReviewBusinessProjectionReadiness(db);
  return readiness.indexedReadsAllowed;
}

/**
 * A completed migration is not enough to authorize indexed reads forever: a
 * stale scheduled writer can append legacy projection records after the
 * marker becomes active. Probe for one legacy record so queue pages/counts
 * fail closed without scanning or loading the collection.
 */
export async function readSupplierReviewBusinessProjectionReadiness(
  db: Firestore,
): Promise<SupplierReviewBusinessProjectionReadiness> {
  const snapshot = await supplierReviewBusinessProjectionReference(db).get();
  const data = snapshot.exists ? snapshot.data() as Partial<SupplierReviewBusinessProjectionStatus> : null;
  const markerActive = isSupplierReviewBusinessProjectionStatusActive(data);
  if (!markerActive) {
    return { markerActive: false, indexedReadsAllowed: false, compatibilityKnown: true };
  }

  try {
    const legacyRecord = await db.collection("supplier_review_queue")
      .where("businessQueueClassesVersion", "!=", SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION)
      .limit(1)
      .get();
    return {
      markerActive: true,
      indexedReadsAllowed: legacyRecord.empty,
      compatibilityKnown: true,
    };
  } catch {
    // An unavailable compatibility probe must never authorize indexed reads.
    return { markerActive: true, indexedReadsAllowed: false, compatibilityKnown: false };
  }
}
