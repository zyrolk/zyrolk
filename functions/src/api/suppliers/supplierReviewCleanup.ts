import { createHash } from "node:crypto";
import { FieldPath, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  decideSupplierQueueItem,
  supplierReviewAllowsRemoval,
  SupplierAdminReviewer,
} from "./supplierApproval";
import {
  reviewRecordIsActionable,
  reviewRecordIsApproved,
  reviewRecordIsTerminalDecision,
  reviewRecordMatchesBusinessFilter,
  SupplierReviewBusinessFilter,
} from "../../scheduled/supplierReviewQueue";

export const SUPPLIER_REVIEW_CLEANUP_CONFIRMATION = "DISMISS_ACTIVE_UNPUBLISHED_SUPPLIER_REVIEWS";
export const SUPPLIER_REVIEW_CLEANUP_SCAN_LIMIT = 2_000;
export const SUPPLIER_REVIEW_CLEANUP_BATCH_LIMIT = 25;

const ACTIVE_REVIEW_FILTERS: SupplierReviewBusinessFilter[] = [
  "new_products",
  "product_updates",
  "needs_attention",
  "conflicts",
  "removed_products",
];

interface SupplierReviewCleanupSourceRecord {
  id: string;
  data: Record<string, unknown>;
  version?: string;
}

export interface SupplierReviewCleanupEligibleItem {
  queueItemId: string;
  sourceId: string;
  supplierCode: string;
  productName: string;
  queueState: string;
  activeViews: SupplierReviewBusinessFilter[];
  expectedPendingRevision: string | null;
  version: string;
}

export interface SupplierReviewCleanupPreview {
  scanComplete: boolean;
  scanLimit: number;
  totalScanned: number;
  totalEligibleActiveItems: number;
  countsBySource: Record<string, number>;
  countsByActiveView: Record<string, number>;
  countsByState: Record<string, number>;
  excludedTerminal: number;
  excludedApprovedLive: number;
  excludedSupplierRemovals: number;
  excludedInactiveOrUnsupported: number;
  preconditionToken: string;
  confirmationPhrase: typeof SUPPLIER_REVIEW_CLEANUP_CONFIRMATION;
  eligibleItems: SupplierReviewCleanupEligibleItem[];
}

export interface SupplierReviewCleanupExecutionResult {
  processed: number;
  dismissed: number;
  failed: number;
  results: Array<{
    queueItemId: string;
    success: boolean;
    error?: string;
  }>;
  remainingPreview: SupplierReviewCleanupPreview;
}

interface SupplierReviewCleanupDependencies {
  preview?: (db: Firestore) => Promise<SupplierReviewCleanupPreview>;
  dismiss?: typeof decideSupplierQueueItem;
}

const recordValue = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const textValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const normalizedState = (data: Record<string, unknown>): string => (
  textValue(data.queueState || data.status).toLowerCase() || "unknown"
);

const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] || 0) + 1;
};

const cleanupSourceId = (data: Record<string, unknown>): string => {
  const supplierSnapshot = recordValue(data.supplierSnapshot);
  return textValue(data.sourceId)
    || textValue(supplierSnapshot.sourceId)
    || textValue(data.supplierId)
    || "unknown";
};

const cleanupVersion = (source: SupplierReviewCleanupSourceRecord): string => {
  if (source.version) return source.version;
  const data = source.data;
  return [
    textValue(data.supplierOfferPendingRevision),
    textValue(data.queueState),
    textValue(data.status),
    textValue(data.reviewStatus),
    textValue(data.decisionAction),
  ].join(":");
};

const cleanupPreconditionToken = (eligibleItems: SupplierReviewCleanupEligibleItem[]): string => createHash("sha256")
  .update(JSON.stringify(eligibleItems.map((item) => [
    item.queueItemId,
    item.expectedPendingRevision,
    item.version,
  ])))
  .digest("hex");

export function buildSupplierReviewCleanupPreview(
  sources: SupplierReviewCleanupSourceRecord[],
  options: { scanComplete?: boolean; scanLimit?: number } = {},
): SupplierReviewCleanupPreview {
  const countsBySource: Record<string, number> = {};
  const countsByActiveView: Record<string, number> = Object.fromEntries(
    ACTIVE_REVIEW_FILTERS.map((filter) => [filter, 0]),
  );
  const countsByState: Record<string, number> = {};
  const eligibleItems: SupplierReviewCleanupEligibleItem[] = [];
  let excludedTerminal = 0;
  let excludedApprovedLive = 0;
  let excludedSupplierRemovals = 0;
  let excludedInactiveOrUnsupported = 0;

  for (const source of [...sources].sort((left, right) => left.id.localeCompare(right.id))) {
    const data = source.data;
    const state = normalizedState(data);
    const status = textValue(data.status).toLowerCase();
    if (reviewRecordIsApproved(data)) {
      excludedApprovedLive += 1;
      continue;
    }
    if (reviewRecordIsTerminalDecision(data)) {
      excludedTerminal += 1;
      continue;
    }
    if (reviewRecordMatchesBusinessFilter(data, "removed_products")) {
      excludedSupplierRemovals += 1;
      continue;
    }
    if (
      !reviewRecordIsActionable(data)
      || !supplierReviewAllowsRemoval(data)
      || (status !== "pending" && state !== "conflict")
    ) {
      excludedInactiveOrUnsupported += 1;
      continue;
    }

    const activeViews = ACTIVE_REVIEW_FILTERS.filter((filter) => (
      reviewRecordMatchesBusinessFilter(data, filter)
    ));
    const supplierSnapshot = recordValue(data.supplierSnapshot);
    const productPayload = recordValue(data.productPayload);
    const sourceId = cleanupSourceId(data);
    increment(countsBySource, sourceId);
    increment(countsByState, state);
    activeViews.forEach((filter) => increment(countsByActiveView, filter));
    eligibleItems.push({
      queueItemId: source.id,
      sourceId,
      supplierCode: textValue(data.supplierCode || supplierSnapshot.supplierSku || supplierSnapshot.supplierProductId),
      productName: textValue(data.productName || productPayload.name || supplierSnapshot.name),
      queueState: state,
      activeViews,
      expectedPendingRevision: textValue(data.supplierOfferPendingRevision) || null,
      version: cleanupVersion(source),
    });
  }

  return {
    scanComplete: options.scanComplete !== false,
    scanLimit: options.scanLimit || SUPPLIER_REVIEW_CLEANUP_SCAN_LIMIT,
    totalScanned: sources.length,
    totalEligibleActiveItems: eligibleItems.length,
    countsBySource,
    countsByActiveView,
    countsByState,
    excludedTerminal,
    excludedApprovedLive,
    excludedSupplierRemovals,
    excludedInactiveOrUnsupported,
    preconditionToken: cleanupPreconditionToken(eligibleItems),
    confirmationPhrase: SUPPLIER_REVIEW_CLEANUP_CONFIRMATION,
    eligibleItems,
  };
}

export async function previewSupplierReviewCleanup(db: Firestore): Promise<SupplierReviewCleanupPreview> {
  const snapshot = await db.collection("supplier_review_queue")
    .orderBy(FieldPath.documentId())
    .limit(SUPPLIER_REVIEW_CLEANUP_SCAN_LIMIT + 1)
    .get();
  const scanComplete = snapshot.docs.length <= SUPPLIER_REVIEW_CLEANUP_SCAN_LIMIT;
  const documents = snapshot.docs.slice(0, SUPPLIER_REVIEW_CLEANUP_SCAN_LIMIT);
  return buildSupplierReviewCleanupPreview(documents.map((document) => ({
    id: document.id,
    data: document.data(),
    version: String(document.updateTime?.toMillis() || ""),
  })), { scanComplete });
}

export async function executeSupplierReviewCleanup(
  db: Firestore,
  input: {
    confirmation?: unknown;
    preconditionToken?: unknown;
    expectedEligibleCount?: unknown;
    batchLimit?: unknown;
  },
  reviewer: SupplierAdminReviewer,
  dependencies: SupplierReviewCleanupDependencies = {},
): Promise<SupplierReviewCleanupExecutionResult> {
  if (input.confirmation !== SUPPLIER_REVIEW_CLEANUP_CONFIRMATION) {
    throw new ApiError("Supplier Product Review cleanup confirmation is required.", 400);
  }
  const preconditionToken = textValue(input.preconditionToken);
  if (!/^[a-f0-9]{64}$/u.test(preconditionToken)) {
    throw new ApiError("Supplier Product Review cleanup precondition is invalid.", 400);
  }
  const expectedEligibleCount = Number(input.expectedEligibleCount);
  if (!Number.isInteger(expectedEligibleCount) || expectedEligibleCount < 0) {
    throw new ApiError("Supplier Product Review cleanup eligible count is invalid.", 400);
  }
  const requestedBatchLimit = input.batchLimit === undefined
    ? SUPPLIER_REVIEW_CLEANUP_BATCH_LIMIT
    : Number(input.batchLimit);
  if (!Number.isInteger(requestedBatchLimit) || requestedBatchLimit < 1 || requestedBatchLimit > SUPPLIER_REVIEW_CLEANUP_BATCH_LIMIT) {
    throw new ApiError(`Supplier Product Review cleanup batch limit must be between 1 and ${SUPPLIER_REVIEW_CLEANUP_BATCH_LIMIT}.`, 400);
  }

  const preview = await (dependencies.preview || previewSupplierReviewCleanup)(db);
  if (!preview.scanComplete) {
    throw new ApiError("Supplier Product Review cleanup preview exceeded its safe scan limit.", 409);
  }
  if (
    preview.preconditionToken !== preconditionToken
    || preview.totalEligibleActiveItems !== expectedEligibleCount
  ) {
    throw new ApiError("Supplier Product Review changed after preview. Run the dry-run again.", 409);
  }

  const dismiss = dependencies.dismiss || decideSupplierQueueItem;
  const results: SupplierReviewCleanupExecutionResult["results"] = [];
  for (const item of preview.eligibleItems.slice(0, requestedBatchLimit)) {
    try {
      await dismiss(db, item.queueItemId, "deleted", reviewer, {
        deletionReason: "review_removed_by_admin: pre-launch Product Review cleanup",
        expectedPendingRevision: item.expectedPendingRevision || undefined,
      });
      results.push({ queueItemId: item.queueItemId, success: true });
    } catch (error) {
      results.push({
        queueItemId: item.queueItemId,
        success: false,
        error: error instanceof ApiError
          ? error.message
          : "Supplier review item could not be dismissed safely.",
      });
    }
  }

  const remainingPreview = await (dependencies.preview || previewSupplierReviewCleanup)(db);
  return {
    processed: results.length,
    dismissed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    results,
    remainingPreview,
  };
}
