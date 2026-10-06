import type { Firestore } from "firebase-admin/firestore";

export const SUPPLIER_REVIEW_BUSINESS_PROJECTION_COLLECTION = "supplier_read_model_meta";
export const SUPPLIER_REVIEW_BUSINESS_PROJECTION_DOCUMENT = "supplier_review_queue_business_projection";
export const SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION = 1;

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

export const supplierReviewBusinessProjectionReference = (db: Firestore) => (
  db.collection(SUPPLIER_REVIEW_BUSINESS_PROJECTION_COLLECTION)
    .doc(SUPPLIER_REVIEW_BUSINESS_PROJECTION_DOCUMENT)
);

/**
 * Business queue indexes remain disabled until every existing record has the
 * same projection version. This preserves legacy behavior during deployment.
 */
export async function isSupplierReviewBusinessProjectionActive(db: Firestore): Promise<boolean> {
  const snapshot = await supplierReviewBusinessProjectionReference(db).get();
  const data = snapshot.exists ? snapshot.data() as Partial<SupplierReviewBusinessProjectionStatus> : null;
  return data?.status === "active" && data.version === SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION;
}
