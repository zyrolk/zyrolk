import type { Firestore } from "firebase-admin/firestore";

export const SUPPLIER_MEDIA_QUEUE_PROJECTION_COLLECTION = "supplier_read_model_meta";
export const SUPPLIER_MEDIA_QUEUE_PROJECTION_DOCUMENT = "supplier_review_queue_media_projection";
export const SUPPLIER_MEDIA_QUEUE_PROJECTION_VERSION = 1;

export interface SupplierMediaQueueProjectionStatus {
  status: "pending" | "active";
  version: number;
  scanned: number;
  projected: number;
  lastDocumentId: string | null;
  startedAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
}

export const supplierMediaQueueProjectionReference = (db: Firestore) => (
  db.collection(SUPPLIER_MEDIA_QUEUE_PROJECTION_COLLECTION).doc(SUPPLIER_MEDIA_QUEUE_PROJECTION_DOCUMENT)
);

/**
 * The indexed media query is enabled only after the bounded projection pass
 * has completed. Until then, the read model keeps its legacy compatibility
 * path so deployment cannot turn missing legacy fields into an empty queue.
 */
export async function isSupplierMediaQueueProjectionActive(db: Firestore): Promise<boolean> {
  const snapshot = await supplierMediaQueueProjectionReference(db).get();
  const data = snapshot.exists ? snapshot.data() as Partial<SupplierMediaQueueProjectionStatus> : null;
  return data?.status === "active" && data.version === SUPPLIER_MEDIA_QUEUE_PROJECTION_VERSION;
}
