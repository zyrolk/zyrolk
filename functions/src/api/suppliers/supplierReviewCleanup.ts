import { createHash } from "node:crypto";
import { FieldPath, FieldValue, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  decideSupplierQueueItem,
  supplierReviewAllowsRemoval,
  SupplierAdminReviewer,
} from "./supplierApproval";
import { createSupplierAuditEvent } from "./supplierAuditTrail";
import {
  projectSupplierOfferForAdmin,
  SupplierProductOffer,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "./supplierOfferEngine";
import {
  buildSupplierQueueIdentityProjection,
  getSupplierQueueIdentityCandidate,
  resolveSupplierQueueIdentity,
} from "./supplierQueueIdentity";
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
export const PRELAUNCH_ORPHANED_DEAD_LETTER_CLEANUP_REASON = "prelaunch_orphaned_dead_letter_cleanup";

const ACTIVE_REVIEW_FILTERS: SupplierReviewBusinessFilter[] = [
  "new_products",
  "product_updates",
  "needs_attention",
  "conflicts",
  "removed_products",
];

const MAX_QUEUE_ID_LENGTH = 180;

export type SupplierReviewCleanupEligibilityKind =
  | "normal_active"
  | "orphaned_dead_letter"
  | "ineligible";

export interface SupplierReviewCleanupEligibility {
  kind: SupplierReviewCleanupEligibilityKind;
  reason?: string;
  expectedPendingRevision?: string | null;
}

interface SupplierReviewCleanupSourceRecord {
  id: string;
  data: Record<string, unknown>;
  version?: string;
  offer?: SupplierProductOffer | null;
}

export interface SupplierReviewCleanupEligibleItem {
  queueItemId: string;
  sourceId: string;
  supplierCode: string;
  productName: string;
  queueState: string;
  activeViews: SupplierReviewBusinessFilter[];
  cleanupKind: Exclude<SupplierReviewCleanupEligibilityKind, "ineligible">;
  expectedPendingRevision: string | null;
  version: string;
}

export interface SupplierReviewCleanupPreview {
  scanComplete: boolean;
  scanLimit: number;
  totalScanned: number;
  totalEligibleActiveItems: number;
  eligibleNormalActiveItems: number;
  eligibleOrphanedDeadLetterItems: number;
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
  dismissOrphaned?: typeof dismissOrphanedDeadLetterObservationForPrelaunchCleanup;
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

const cleanupPendingRevision = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value.trim())) return "";
  return value.trim();
};

const cleanupQueueItemId = (value: unknown): string => {
  if (typeof value !== "string") throw new ApiError("A supplier review queue item ID is required.", 400);
  const id = value.trim();
  if (!id || id.length > MAX_QUEUE_ID_LENGTH || id.includes("/")) {
    throw new ApiError("The supplier review queue item ID is invalid.", 400);
  }
  return id;
};

const cleanupReviewQueueItemId = (queueItemId: string): string => (
  queueItemId.startsWith("change-") ? cleanupQueueItemId(queueItemId.slice("change-".length)) : queueItemId
);

const cleanupPreconditionToken = (eligibleItems: SupplierReviewCleanupEligibleItem[]): string => createHash("sha256")
  .update(JSON.stringify(eligibleItems.map((item) => [
    item.queueItemId,
    item.cleanupKind,
    item.expectedPendingRevision,
    item.version,
  ])))
  .digest("hex");

const pendingObservationForOffer = (
  offer: SupplierProductOffer | null | undefined,
): SupplierProductOffer["pendingObservation"] => offer?.pendingObservation || null;

const queueMatchesPendingObservation = (
  queueItemId: string,
  queueRevision: string,
  offer: SupplierProductOffer,
): boolean => {
  const pendingObservation = pendingObservationForOffer(offer);
  if (!pendingObservation) return false;
  return pendingObservation.revision === queueRevision
    && pendingObservation.reviewQueueItemId === cleanupReviewQueueItemId(queueItemId);
};

/** Shared preview/execution predicate for prelaunch cleanup eligibility. */
export function evaluateSupplierReviewCleanupEligibility(
  queueItemId: string,
  data: Record<string, unknown>,
  offer?: SupplierProductOffer | null,
): SupplierReviewCleanupEligibility {
  const state = normalizedState(data);
  const status = textValue(data.status).toLowerCase();
  const queueRevision = cleanupPendingRevision(data.supplierOfferPendingRevision);
  const pendingObservation = pendingObservationForOffer(offer || null);

  if (reviewRecordIsApproved(data)) {
    return { kind: "ineligible", reason: "approved_live" };
  }
  if (reviewRecordIsTerminalDecision(data)) {
    return { kind: "ineligible", reason: "terminal" };
  }
  if (reviewRecordMatchesBusinessFilter(data, "removed_products")) {
    return { kind: "ineligible", reason: "supplier_removal" };
  }
  if (
    !reviewRecordIsActionable(data)
    || !supplierReviewAllowsRemoval(data)
    || (status !== "pending" && state !== "conflict")
  ) {
    return { kind: "ineligible", reason: "inactive_or_unsupported" };
  }

  if (pendingObservation) {
    if (!queueRevision || !queueMatchesPendingObservation(queueItemId, queueRevision, offer!)) {
      return { kind: "ineligible", reason: "pending_observation_revision_mismatch" };
    }
    return { kind: "normal_active", expectedPendingRevision: queueRevision };
  }

  if (state === "dead_letter" && queueRevision) {
    if (!offer) {
      return { kind: "ineligible", reason: "missing_linked_offer" };
    }
    return { kind: "orphaned_dead_letter", expectedPendingRevision: queueRevision };
  }

  if (queueRevision) {
    return { kind: "ineligible", reason: "stale_queue_revision_without_offer_observation" };
  }

  return { kind: "normal_active", expectedPendingRevision: null };
}

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
  let eligibleNormalActiveItems = 0;
  let eligibleOrphanedDeadLetterItems = 0;

  for (const source of [...sources].sort((left, right) => left.id.localeCompare(right.id))) {
    const data = source.data;
    const eligibility = evaluateSupplierReviewCleanupEligibility(source.id, data, source.offer);
    if (eligibility.kind === "ineligible") {
      if (eligibility.reason === "approved_live") excludedApprovedLive += 1;
      else if (eligibility.reason === "terminal") excludedTerminal += 1;
      else if (eligibility.reason === "supplier_removal") excludedSupplierRemovals += 1;
      else excludedInactiveOrUnsupported += 1;
      continue;
    }

    const activeViews = ACTIVE_REVIEW_FILTERS.filter((filter) => (
      reviewRecordMatchesBusinessFilter(data, filter)
    ));
    const supplierSnapshot = recordValue(data.supplierSnapshot);
    const productPayload = recordValue(data.productPayload);
    const sourceId = cleanupSourceId(data);
    const state = normalizedState(data);
    increment(countsBySource, sourceId);
    increment(countsByState, state);
    activeViews.forEach((filter) => increment(countsByActiveView, filter));
    if (eligibility.kind === "normal_active") eligibleNormalActiveItems += 1;
    if (eligibility.kind === "orphaned_dead_letter") eligibleOrphanedDeadLetterItems += 1;
    eligibleItems.push({
      queueItemId: source.id,
      sourceId,
      supplierCode: textValue(data.supplierCode || supplierSnapshot.supplierSku || supplierSnapshot.supplierProductId),
      productName: textValue(data.productName || productPayload.name || supplierSnapshot.name),
      queueState: state,
      activeViews,
      cleanupKind: eligibility.kind,
      expectedPendingRevision: eligibility.expectedPendingRevision || null,
      version: cleanupVersion(source),
    });
  }

  return {
    scanComplete: options.scanComplete !== false,
    scanLimit: options.scanLimit || SUPPLIER_REVIEW_CLEANUP_SCAN_LIMIT,
    totalScanned: sources.length,
    totalEligibleActiveItems: eligibleItems.length,
    eligibleNormalActiveItems,
    eligibleOrphanedDeadLetterItems,
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
  const offerIds = new Set<string>();
  for (const document of documents) {
    const candidate = getSupplierQueueIdentityCandidate(document.data());
    if (candidate.deterministicOfferId) offerIds.add(candidate.deterministicOfferId);
    if (candidate.claimedOfferId) offerIds.add(candidate.claimedOfferId);
  }
  const offerSnapshots = offerIds.size > 0
    ? await db.getAll(...[...offerIds].map((offerId) => db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(offerId)))
    : [];
  const offersById = new Map<string, SupplierProductOffer>();
  for (const offerSnapshot of offerSnapshots) {
    if (!offerSnapshot.exists) continue;
    const offer = projectSupplierOfferForAdmin({ id: offerSnapshot.id, ...offerSnapshot.data() });
    if (offer) offersById.set(offer.id, offer);
  }
  return buildSupplierReviewCleanupPreview(documents.map((document) => {
    const candidate = getSupplierQueueIdentityCandidate(document.data());
    const linkedOffer = offersById.get(candidate.claimedOfferId)
      || offersById.get(candidate.deterministicOfferId)
      || null;
    return {
      id: document.id,
      data: document.data(),
      version: String(document.updateTime?.toMillis() || ""),
      offer: linkedOffer,
    };
  }), { scanComplete });
}

/**
 * Cleanup-only orphaned dead-letter dismissal. Soft-terminalizes the queue
 * observation without mutating supplier offer pending/commercial state.
 */
export async function dismissOrphanedDeadLetterObservationForPrelaunchCleanup(
  db: Firestore,
  queueItemIdInput: unknown,
  reviewer: SupplierAdminReviewer,
  options: { expectedPendingRevision: string },
): Promise<{ success: true; queueItemId: string; action: "deleted"; status: "deleted" }> {
  const requestedQueueItemId = cleanupQueueItemId(queueItemIdInput);
  const reviewQueueItemId = cleanupReviewQueueItemId(requestedQueueItemId);
  const expectedPendingRevision = cleanupPendingRevision(options.expectedPendingRevision);
  if (!expectedPendingRevision) {
    throw new ApiError("Supplier Product Review cleanup orphaned revision is invalid.", 400);
  }

  await db.runTransaction(async (transaction) => {
    const reviewReference = db.collection("supplier_review_queue").doc(reviewQueueItemId);
    const pendingReference = db.collection("supplier_pending_changes").doc(`change-${reviewQueueItemId}`);
    const importReference = db.collection("supplier_import_queue").doc(reviewQueueItemId);
    const [reviewSnapshot, pendingSnapshot] = await Promise.all([
      transaction.get(reviewReference),
      transaction.get(pendingReference),
    ]);
    if (!reviewSnapshot.exists) {
      throw new ApiError("Supplier review item was already processed or no longer exists.", 409);
    }

    const queueData = reviewSnapshot.data() || {};
    const resolvedQueueIdentity = await resolveSupplierQueueIdentity(db, transaction, queueData);
    const eligibility = evaluateSupplierReviewCleanupEligibility(
      reviewQueueItemId,
      queueData,
      resolvedQueueIdentity.offer,
    );
    if (eligibility.kind !== "orphaned_dead_letter") {
      throw new ApiError("Supplier review item is not eligible for orphaned dead-letter cleanup.", 409);
    }
    if (eligibility.expectedPendingRevision !== expectedPendingRevision) {
      throw new ApiError("Product Review changed after it was opened; reload before deciding.", 409);
    }

    const reviewQueueState = String(reviewSnapshot.data()?.queueState || "").toLowerCase();
    const decisionAction = String(queueData.decisionAction || "").toLowerCase();
    const decisionRevision = cleanupPendingRevision(queueData.decisionPendingRevision);
    if (reviewRecordIsTerminalDecision(queueData)) {
      if (
        decisionAction === "deleted"
        && decisionRevision === expectedPendingRevision
        && textValue(queueData.decisionAuditId)
      ) {
        return;
      }
      throw new ApiError("Supplier review item is no longer pending; reload and try again.", 409);
    }

    const queueIdentityProjection = buildSupplierQueueIdentityProjection(queueData, {
      canonicalProductId: resolvedQueueIdentity.canonicalProductId,
      supplierOfferId: resolvedQueueIdentity.supplierOfferId,
    });
    const previousState = reviewQueueState || "dead_letter";
    const now = FieldValue.serverTimestamp();
    const auditId = createSupplierAuditEvent(db, transaction, {
      queueItemId: reviewQueueItemId,
      queueItem: { ...queueData, ...queueIdentityProjection },
      action: "delete",
      previousState,
      newState: "suppressed",
      admin: reviewer,
      reason: PRELAUNCH_ORPHANED_DEAD_LETTER_CLEANUP_REASON,
      timestamp: now,
    });
    transaction.set(reviewReference, {
      ...queueIdentityProjection,
      queueState: "suppressed",
      status: "Rejected",
      decisionAction: "deleted",
      decisionAuditId: auditId,
      decisionPendingRevision: expectedPendingRevision,
      decisionCompletedAt: now,
      decisionCompletedBy: reviewer,
      approvalConflict: FieldValue.delete(),
      leaseOwner: FieldValue.delete(),
      leaseAcquiredAt: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
      leaseId: FieldValue.delete(),
      processingStartedAt: FieldValue.delete(),
    }, { merge: true });
    if (pendingSnapshot.exists) transaction.delete(pendingReference);
    transaction.delete(importReference);
  });

  return {
    success: true,
    queueItemId: requestedQueueItemId,
    action: "deleted",
    status: "deleted",
  };
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
  const dismissOrphaned = dependencies.dismissOrphaned || dismissOrphanedDeadLetterObservationForPrelaunchCleanup;
  const results: SupplierReviewCleanupExecutionResult["results"] = [];
  for (const item of preview.eligibleItems.slice(0, requestedBatchLimit)) {
    try {
      if (item.cleanupKind === "orphaned_dead_letter") {
        if (!item.expectedPendingRevision) {
          throw new ApiError("Supplier Product Review cleanup orphaned revision is invalid.", 400);
        }
        await dismissOrphaned(db, item.queueItemId, reviewer, {
          expectedPendingRevision: item.expectedPendingRevision,
        });
      } else {
        await dismiss(db, item.queueItemId, "deleted", reviewer, {
          deletionReason: "review_removed_by_admin: pre-launch Product Review cleanup",
          expectedPendingRevision: item.expectedPendingRevision || undefined,
        });
      }
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
