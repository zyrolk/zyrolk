import { FieldValue, Firestore, Transaction } from "firebase-admin/firestore";

export type SupplierAuditAction =
  | "queued"
  | "leased"
  | "processing"
  | "review_pending"
  | "approval_conflict"
  | "approve"
  | "reject"
  | "delete"
  | "retry"
  | "resume"
  | "retryable_failure"
  | "dead_letter";

export interface SupplierAuditActor {
  uid: string;
  email: string;
}

export interface SupplierAuditEventInput {
  queueItemId: string;
  queueItem: Record<string, unknown>;
  action: SupplierAuditAction;
  previousState: string | null;
  newState: string;
  reason?: string;
  admin?: SupplierAuditActor;
  workerId?: string;
  leaseId?: string;
  beforePublicProduct?: Record<string, unknown>;
  afterPublicProduct?: Record<string, unknown>;
  beforePrivateProduct?: Record<string, unknown>;
  afterPrivateProduct?: Record<string, unknown>;
  conflict?: {
    reason: string;
    changedFields: readonly string[];
    previousVersion: string;
    currentVersion: string;
    oldValues: Partial<Record<string, unknown>>;
    newValues: Partial<Record<string, unknown>>;
  };
  timestamp?: FieldValue;
  now?: number;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const toMillis = (value: unknown): number => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  return 0;
};

const importantValue = (
  field: "price" | "stock" | "supplierSku" | "supplierCost" | "status" | "category" | "brand",
  product: Record<string, unknown>,
  privateProduct: Record<string, unknown>,
  queueItem: Record<string, unknown>,
): unknown => {
  const specs = asRecord(product.specs);
  switch (field) {
    case "price": return product.price ?? product.sellingPrice;
    case "stock": return product.stock;
    case "supplierSku": return privateProduct.supplierItemCode ?? privateProduct.supplierSku ?? queueItem.supplierSku ?? queueItem.supplierCode;
    case "supplierCost": return privateProduct.supplierPurchasePrice ?? privateProduct.costPrice ?? privateProduct.supplierPrice ?? queueItem.supplierPurchasePrice;
    case "status": return product.status ?? (product.published === true ? "published" : product.approved === true ? "approved" : product.isActive === false ? "inactive" : undefined);
    case "category": return product.category;
    case "brand": return product.brand ?? specs.brand;
  }
};

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** Returns a compact, allowlisted change set; no whole product diff is stored. */
export function buildSupplierImportantFieldChanges(input: Pick<SupplierAuditEventInput,
  "queueItem" | "beforePublicProduct" | "afterPublicProduct" | "beforePrivateProduct" | "afterPrivateProduct" | "previousState" | "newState"
>): Record<string, { before: unknown; after: unknown }> {
  const beforePublic = input.beforePublicProduct || {};
  const afterPublic = input.afterPublicProduct || {};
  const beforePrivate = input.beforePrivateProduct || {};
  const afterPrivate = input.afterPrivateProduct || {};
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of ["price", "stock", "supplierSku", "supplierCost", "status", "category", "brand"] as const) {
    const before = importantValue(field, beforePublic, beforePrivate, input.queueItem);
    const after = importantValue(field, afterPublic, afterPrivate, input.queueItem);
    if (!equal(before, after)) changed[field] = { before: before ?? null, after: after ?? null };
  }
  // Rejections and lifecycle events may not carry a product snapshot, but their
  // workflow status still changed and must remain visible in the audit history.
  if (!changed.status && input.previousState !== input.newState) {
    changed.status = { before: input.previousState, after: input.newState };
  }
  return changed;
}

/**
 * Produces the append-only event format used by all trusted Supplier Hub workers
 * and decision endpoints.  Firestore Rules deny every client-side audit write.
 */
export function buildSupplierAuditEvent(input: SupplierAuditEventInput, eventId: string): Record<string, unknown> {
  const queueItem = input.queueItem;
  const supplierSnapshot = asRecord(queueItem.supplierSnapshot);
  const sourceId = asString(queueItem.sourceId) || "unknown";
  const supplierId = asString(queueItem.supplierId) || asString(supplierSnapshot.supplierId) || "unknown";
  const productId = asString(queueItem.productId) || asString(asRecord(queueItem.productPayload).id) || "";
  const now = input.now ?? Date.now();
  const queueCreatedAt = toMillis(queueItem.queueCreatedAt);
  const processingStartedAt = toMillis(queueItem.processingStartedAt);
  const changes = buildSupplierImportantFieldChanges(input);
  if (input.conflict) {
    for (const field of input.conflict.changedFields) {
      changes[field] = {
        before: input.conflict.oldValues[field] ?? null,
        after: input.conflict.newValues[field] ?? null,
      };
    }
  }
  const event: Record<string, unknown> = {
    id: eventId,
    eventId,
    queueItemId: input.queueItemId,
    supplierId,
    sourceId,
    productId: productId || null,
    action: input.action,
    previousState: input.previousState,
    newState: input.newState,
    adminUserId: input.admin?.uid || null,
    adminEmail: input.admin?.email || null,
    timestamp: input.timestamp || FieldValue.serverTimestamp(),
    correlationId: asString(queueItem.correlationId) || input.queueItemId,
    retryCount: Number(queueItem.retryCount || 0),
    connector: asString(queueItem.connector) || null,
    batchId: asString(queueItem.batchId) || null,
    workerId: input.workerId || null,
    leaseId: input.leaseId || asString(queueItem.leaseId) || null,
    ...(queueCreatedAt > 0 ? { approvalLatencyMs: Math.max(0, now - queueCreatedAt) } : {}),
    ...(processingStartedAt > 0 ? { processingDurationMs: Math.max(0, now - processingStartedAt) } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 1_000) } : {}),
    ...(Object.keys(changes).length > 0 ? { changedFields: changes } : {}),
    ...(input.conflict ? {
      approvalConflict: {
        reason: input.conflict.reason,
        detectedFields: [...input.conflict.changedFields],
        previousVersion: input.conflict.previousVersion,
        currentVersion: input.conflict.currentVersion,
      },
    } : {}),
  };

  // Immutable snapshots are intentionally limited to decision events. They make a
  // later, separately-authorized rollback possible without adding rollback logic now.
  if (input.afterPublicProduct || input.afterPrivateProduct || input.beforePublicProduct || input.beforePrivateProduct) {
    event.rollback = {
      productId: productId || null,
      before: {
        public: input.beforePublicProduct || null,
        private: input.beforePrivateProduct || null,
      },
      after: {
        public: input.afterPublicProduct || null,
        private: input.afterPrivateProduct || null,
      },
    };
  }
  return event;
}

/** Transactional create is deliberate: audit documents are never overwritten. */
export function createSupplierAuditEvent(
  db: Firestore,
  transaction: Transaction,
  input: SupplierAuditEventInput,
): string {
  const reference = db.collection("supplier_approval_audit").doc();
  transaction.create(reference, buildSupplierAuditEvent(input, reference.id));
  return reference.id;
}

/** Use for an API-request event that follows a completed worker transaction. */
export async function appendSupplierAuditEvent(db: Firestore, input: SupplierAuditEventInput): Promise<string> {
  return db.runTransaction(async (transaction) => createSupplierAuditEvent(db, transaction, input));
}
