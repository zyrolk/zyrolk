import { createHash } from "node:crypto";
import { Firestore } from "firebase-admin/firestore";
import {
  SupplierSyncAttemptCounters,
  SupplierSyncCumulativeCounters,
  SupplierSyncJobAttemptRecord,
  SupplierSyncJobRecord,
} from "./supplierSyncJobs";

export const SUPPLIER_SYNC_EVIDENCE_VERSION = 2;

export const SUPPLIER_SYNC_ISSUE_CATEGORIES = [
  "SUPPLIER_DATA_GAP",
  "ADMIN_REVIEW_REQUIRED",
  "VALIDATION_REJECTION",
  "DUPLICATE_SUPPLIER_PRODUCT",
  "MEDIA_RETRYABLE",
  "MEDIA_PERMANENT",
  "NORMALIZATION_ERROR",
  "CHECKPOINT_ERROR",
  "COUNTER_RECONCILIATION_ERROR",
  "SYSTEM_ERROR",
] as const;

export type SupplierSyncIssueCategory = typeof SUPPLIER_SYNC_ISSUE_CATEGORIES[number];
export type SupplierSyncReconciliationStatus = "VERIFIED" | "ISSUES" | "LEGACY_UNVERIFIED";

export interface SupplierSyncReconciliationIssue {
  category: SupplierSyncIssueCategory;
  message: string;
  attemptId?: string;
  pageCommitId?: string;
}

export interface SupplierSyncPageCommitRecord extends Record<string, unknown> {
  pageCommitId: string;
  jobId: string;
  sourceId: string;
  attemptId: string;
  attemptNumber: number;
  traversalId: string;
  status: "committed";
  cursorBefore: string | null;
  cursorAfter: string | null;
  pageFingerprint: string;
  counters: SupplierSyncAttemptCounters;
  checkpointAfter: Record<string, unknown>;
  committedAt: string;
}

export interface SupplierSyncReconciliationResult {
  status: SupplierSyncReconciliationStatus;
  issues: SupplierSyncReconciliationIssue[];
  attemptCount: number;
  pageCommitCount: number;
  cumulativeCounters: SupplierSyncCumulativeCounters | null;
  reconciledAt: string;
}

export interface SupplierSyncAttemptEvidenceSummary {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  kind: SupplierSyncJobAttemptRecord["kind"];
  status: SupplierSyncJobAttemptRecord["status"];
  startedAt: string;
  completedAt: string | null;
  cursorBefore: Record<string, string | null>;
  cursorAfter: Record<string, string | null>;
  requestedTotalProductLimit: number | null;
  effectiveTotalProductLimit: number | null;
  requestedPageSize: number | null;
  effectivePageSize: Record<string, number>;
  remainingLimitAtStart: Record<string, number | null>;
  counters: SupplierSyncAttemptCounters;
  stopReason: string | null;
  errorClass: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  retryable: boolean | null;
}

export type SupplierSyncEvidenceIssueGroupKey = "supplierData" | "adminReview" | "media" | "system";

export interface SupplierSyncEvidenceIssueGroup {
  key: SupplierSyncEvidenceIssueGroupKey;
  label: string;
  available: boolean;
  issues: SupplierSyncReconciliationIssue[];
}

export interface SupplierSyncEvidenceReadModel {
  evidenceVersion: number | null;
  legacy: boolean;
  attempts: SupplierSyncAttemptEvidenceSummary[];
  reconciliation: SupplierSyncReconciliationResult;
  issueGroups: SupplierSyncEvidenceIssueGroup[];
}

export class SupplierSyncCheckpointConflictError extends Error {
  readonly code = "CHECKPOINT_ERROR";
  readonly category: SupplierSyncIssueCategory = "CHECKPOINT_ERROR";

  constructor(
    readonly sourceId: string,
    readonly expectedCursor: string | null,
    readonly actualCursor: string | null,
  ) {
    super(`Supplier cursor conflict for ${sourceId}: expected ${expectedCursor || "<start>"}, found ${actualCursor || "<start>"}.`);
    this.name = "SupplierSyncCheckpointConflictError";
  }
}

const safeCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const safeOptionalCount = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const normalizedCursor = (value: unknown): string | null => {
  const cursor = typeof value === "string" ? value.trim() : "";
  return cursor || null;
};

const sourceCursorFromRecord = (source: Record<string, unknown>): string | null => {
  const catalogSync = asRecord(source.catalogSync);
  return normalizedCursor(catalogSync.cursor ?? source.catalogCursor);
};

const countersFrom = (value: unknown): SupplierSyncAttemptCounters => {
  const raw = asRecord(value);
  return {
    scanned: safeCount(raw.scanned),
    processed: safeCount(raw.processed),
    queued: safeCount(raw.queued),
    new: safeCount(raw.new),
    changeCandidates: safeCount(raw.changeCandidates),
    unchanged: safeCount(raw.unchanged),
    rejected: safeOptionalCount(raw.rejected),
    failed: safeCount(raw.failed),
    warnings: safeCount(raw.warnings),
    pages: safeCount(raw.pages),
  };
};

const cumulativeFrom = (value: unknown): SupplierSyncCumulativeCounters | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = asRecord(value);
  return {
    ...countersFrom(raw),
    rejected: safeOptionalCount(raw.rejected),
  };
};

const safeCursorMap = (value: unknown): Record<string, string | null> => Object.fromEntries(
  Object.entries(asRecord(value))
    .filter(([sourceId]) => sourceId && sourceId.length <= 160 && !sourceId.includes("/"))
    .map(([sourceId, cursor]) => [sourceId, normalizedCursor(cursor)]),
);

const safeNumberMap = (value: unknown, allowNull: boolean): Record<string, number | null> => Object.fromEntries(
  Object.entries(asRecord(value))
    .filter(([sourceId]) => sourceId && sourceId.length <= 160 && !sourceId.includes("/"))
    .map(([sourceId, numberValue]) => [sourceId, allowNull ? safeOptionalCount(numberValue) : safeCount(numberValue)]),
);

const projectAttemptEvidence = (attempt: SupplierSyncJobAttemptRecord): SupplierSyncAttemptEvidenceSummary => ({
  attemptId: String(attempt.attemptId || ""),
  jobId: String(attempt.jobId || ""),
  attemptNumber: safeCount(attempt.attemptNumber),
  kind: attempt.kind,
  status: attempt.status,
  startedAt: String(attempt.startedAt || ""),
  completedAt: typeof attempt.completedAt === "string" ? attempt.completedAt : null,
  cursorBefore: safeCursorMap(attempt.cursorBefore),
  cursorAfter: safeCursorMap(attempt.cursorAfter),
  requestedTotalProductLimit: safeOptionalCount(attempt.requestedTotalProductLimit),
  effectiveTotalProductLimit: safeOptionalCount(attempt.effectiveTotalProductLimit),
  requestedPageSize: safeOptionalCount(attempt.requestedPageSize),
  effectivePageSize: safeNumberMap(attempt.effectivePageSize, false) as Record<string, number>,
  remainingLimitAtStart: safeNumberMap(attempt.remainingLimitAtStart, true),
  counters: countersFrom(attempt.counters),
  stopReason: typeof attempt.stopReason === "string" ? attempt.stopReason : null,
  errorClass: typeof attempt.errorClass === "string" ? attempt.errorClass : null,
  errorCode: typeof attempt.errorCode === "string" ? attempt.errorCode : null,
  errorMessageSafe: typeof attempt.errorMessageSafe === "string" ? attempt.errorMessageSafe.slice(0, 500) : null,
  retryable: typeof attempt.retryable === "boolean" ? attempt.retryable : null,
});

const issueGroupForCategory = (category: SupplierSyncIssueCategory): SupplierSyncEvidenceIssueGroupKey => {
  if (["SUPPLIER_DATA_GAP", "VALIDATION_REJECTION", "DUPLICATE_SUPPLIER_PRODUCT"].includes(category)) return "supplierData";
  if (category === "ADMIN_REVIEW_REQUIRED") return "adminReview";
  if (["MEDIA_RETRYABLE", "MEDIA_PERMANENT"].includes(category)) return "media";
  return "system";
};

const safeIssueCategory = (value: unknown): SupplierSyncIssueCategory => {
  const normalized = String(value || "").toUpperCase() as SupplierSyncIssueCategory;
  return SUPPLIER_SYNC_ISSUE_CATEGORIES.includes(normalized) ? normalized : "SYSTEM_ERROR";
};

const buildEvidenceIssueGroups = (
  reconciliationIssues: readonly SupplierSyncReconciliationIssue[],
  attempts: readonly SupplierSyncJobAttemptRecord[],
  available: boolean,
): SupplierSyncEvidenceIssueGroup[] => {
  const groups: Record<SupplierSyncEvidenceIssueGroupKey, SupplierSyncEvidenceIssueGroup> = {
    supplierData: { key: "supplierData", label: "Supplier data", available, issues: [] },
    adminReview: { key: "adminReview", label: "Admin review", available, issues: [] },
    media: { key: "media", label: "Media", available, issues: [] },
    system: { key: "system", label: "System / checkpoint / reconciliation", available, issues: [] },
  };
  const append = (issue: SupplierSyncReconciliationIssue): void => {
    groups[issueGroupForCategory(issue.category)].issues.push(issue);
  };
  reconciliationIssues.forEach(append);
  attempts.forEach((attempt) => {
    if (!attempt.errorClass && !attempt.errorCode && !attempt.errorMessageSafe) return;
    const category = safeIssueCategory(attempt.errorClass) === "SYSTEM_ERROR"
      ? classifySupplierSyncIssue({ code: attempt.errorCode, message: attempt.errorMessageSafe })
      : safeIssueCategory(attempt.errorClass);
    append({
      category,
      message: attempt.errorMessageSafe || attempt.errorCode || attempt.errorClass || "Attempt reported an error.",
      attemptId: attempt.attemptId,
    });
  });
  return Object.values(groups);
};

const sameNullableCursor = (left: unknown, right: unknown): boolean => normalizedCursor(left) === normalizedCursor(right);

const terminalAttempt = (status: unknown): boolean => (
  status === "waiting" || status === "completed" || status === "failed" || status === "cancelled"
);

const addCounters = (left: SupplierSyncCumulativeCounters, right: SupplierSyncAttemptCounters): SupplierSyncCumulativeCounters => ({
  scanned: left.scanned + right.scanned,
  processed: left.processed + right.processed,
  queued: left.queued + right.queued,
  new: left.new + right.new,
  changeCandidates: left.changeCandidates + right.changeCandidates,
  unchanged: left.unchanged + right.unchanged,
  rejected: left.rejected === null || right.rejected === null ? null : left.rejected + right.rejected,
  failed: left.failed + right.failed,
  warnings: left.warnings + right.warnings,
  pages: left.pages + right.pages,
});

const emptyCounters = (): SupplierSyncCumulativeCounters => ({
  scanned: 0,
  processed: 0,
  queued: 0,
  new: 0,
  changeCandidates: 0,
  unchanged: 0,
  rejected: 0,
  failed: 0,
  warnings: 0,
  pages: 0,
});

const addAttemptCounters = (
  left: SupplierSyncCumulativeCounters,
  right: SupplierSyncAttemptCounters,
): SupplierSyncCumulativeCounters => ({
  scanned: left.scanned + right.scanned,
  processed: left.processed + right.processed,
  queued: left.queued + right.queued,
  new: left.new + right.new,
  changeCandidates: left.changeCandidates + right.changeCandidates,
  unchanged: left.unchanged + right.unchanged,
  rejected: left.rejected === null || right.rejected === null ? null : left.rejected + right.rejected,
  failed: left.failed + right.failed,
  warnings: left.warnings + right.warnings,
  pages: left.pages + right.pages,
});

const countersEqual = (left: SupplierSyncCumulativeCounters, right: SupplierSyncCumulativeCounters): boolean => (
  left.scanned === right.scanned
  && left.processed === right.processed
  && left.queued === right.queued
  && left.new === right.new
  && left.changeCandidates === right.changeCandidates
  && left.unchanged === right.unchanged
  && left.rejected === right.rejected
  && left.failed === right.failed
  && left.warnings === right.warnings
  && left.pages === right.pages
);

const terminalEquation = (counters: SupplierSyncAttemptCounters): boolean => (
  counters.rejected !== null
  && counters.processed === counters.new + counters.changeCandidates + counters.unchanged + counters.rejected + counters.failed
);

export function classifySupplierSyncIssue(error: unknown): SupplierSyncIssueCategory {
  const value = asRecord(error);
  const code = String(value.code || "").toUpperCase();
  const message = String(error instanceof Error ? error.message : error || "").toUpperCase();
  if (code === "CHECKPOINT_ERROR" || message.includes("CURSOR CONFLICT")) return "CHECKPOINT_ERROR";
  if (code === "COUNTER_RECONCILIATION_ERROR") return "COUNTER_RECONCILIATION_ERROR";
  if (code === "IMAGE_TOO_LARGE" || message.includes("IMAGE_TOO_LARGE")) return "MEDIA_PERMANENT";
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|SOCKET|NETWORK|EAI_AGAIN/u.test(code + " " + message)) return "MEDIA_RETRYABLE";
  if (/INVALID[_ ]?URL|MALFORMED[_ ]?URL/u.test(code + " " + message)) return "VALIDATION_REJECTION";
  if (/DUPLICATE|CONFLICT/u.test(code + " " + message)) return "DUPLICATE_SUPPLIER_PRODUCT";
  if (/NORMALIZ/u.test(code + " " + message)) return "NORMALIZATION_ERROR";
  return "SYSTEM_ERROR";
}

export function buildSupplierSyncPageCommitId(
  jobId: string,
  sourceId: string,
  traversalId: string,
  cursorBefore: string | null,
): string {
  return createHash("sha256")
    .update([jobId, sourceId, traversalId, cursorBefore || "<start>"].join("\u0000"))
    .digest("hex");
}

export async function getSupplierSyncPageCommit(
  db: Firestore,
  jobId: string,
  pageCommitId: string,
): Promise<SupplierSyncPageCommitRecord | null> {
  const snapshot = await db.collection("supplier_sync_jobs").doc(jobId).collection("pages").doc(pageCommitId).get();
  return snapshot.exists ? ({ id: snapshot.id, ...snapshot.data() } as unknown as SupplierSyncPageCommitRecord) : null;
}

export async function assertSupplierSyncCursor(
  db: Firestore,
  sourceId: string,
  expectedCursor: string | null,
): Promise<void> {
  const snapshot = await db.collection("supplierSources").doc(sourceId).get();
  const actualCursor = sourceCursorFromRecord(snapshot.data() || {});
  if (!sameNullableCursor(actualCursor, expectedCursor)) {
    throw new SupplierSyncCheckpointConflictError(sourceId, expectedCursor, actualCursor);
  }
}

export async function commitSupplierSyncPage(input: {
  db: Firestore;
  jobId: string;
  sourceId: string;
  attemptId: string;
  attemptNumber: number;
  traversalId: string;
  pageCommitId: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
  pageFingerprint: string;
  counters: SupplierSyncAttemptCounters;
  checkpointAfter: Record<string, unknown>;
  sourcePatch: Record<string, unknown>;
  committedAt?: string;
}): Promise<{ alreadyCommitted: boolean; record: SupplierSyncPageCommitRecord }> {
  const sourceReference = input.db.collection("supplierSources").doc(input.sourceId);
  const pageReference = input.db.collection("supplier_sync_jobs").doc(input.jobId).collection("pages").doc(input.pageCommitId);
  const jobReference = input.db.collection("supplier_sync_jobs").doc(input.jobId);
  const attemptReference = jobReference.collection("attempts").doc(input.attemptId);
  const committedAt = input.committedAt || new Date().toISOString();
  return input.db.runTransaction(async (transaction) => {
    const [sourceSnapshot, pageSnapshot, jobSnapshot, attemptSnapshot] = await Promise.all([
      transaction.get(sourceReference),
      transaction.get(pageReference),
      transaction.get(jobReference),
      transaction.get(attemptReference),
    ]);
    if (pageSnapshot.exists) {
      const existing = { id: pageSnapshot.id, ...pageSnapshot.data() } as unknown as SupplierSyncPageCommitRecord;
      if (existing.pageFingerprint !== input.pageFingerprint
        || !sameNullableCursor(existing.cursorBefore, input.cursorBefore)
        || !sameNullableCursor(existing.cursorAfter, input.cursorAfter)) {
        throw new Error("Supplier page commit identity conflicts with existing durable evidence.");
      }
      return { alreadyCommitted: true, record: existing };
    }
    if (!jobSnapshot.exists) throw new Error("Supplier sync job is missing while committing a page.");
    if (!attemptSnapshot.exists) throw new Error("Supplier sync attempt is missing while committing a page.");
    const actualCursor = sourceCursorFromRecord(sourceSnapshot.data() || {});
    if (!sameNullableCursor(actualCursor, input.cursorBefore)) {
      throw new SupplierSyncCheckpointConflictError(input.sourceId, input.cursorBefore, actualCursor);
    }
    const record: SupplierSyncPageCommitRecord = {
      pageCommitId: input.pageCommitId,
      jobId: input.jobId,
      sourceId: input.sourceId,
      attemptId: input.attemptId,
      attemptNumber: input.attemptNumber,
      traversalId: input.traversalId,
      status: "committed",
      cursorBefore: input.cursorBefore,
      cursorAfter: input.cursorAfter,
      pageFingerprint: input.pageFingerprint,
      counters: input.counters,
      checkpointAfter: input.checkpointAfter,
      committedAt,
    };
    transaction.create(pageReference, record);
    transaction.set(sourceReference, input.sourcePatch, { merge: true });
    const job = jobSnapshot.data() || {};
    const currentCumulative = cumulativeFrom(job.cumulativeCounters) || emptyCounters();
    transaction.set(jobReference, {
      cumulativeCounters: addAttemptCounters(currentCumulative, input.counters),
      durableCursor: {
        ...asRecord(job.durableCursor),
        [input.sourceId]: input.cursorAfter,
      },
      updatedAt: committedAt,
    }, { merge: true });
    const attempt = attemptSnapshot.data() || {};
    const currentAttempt = countersFrom(attempt.counters);
    const nextAttemptCounters: SupplierSyncAttemptCounters = {
      ...addAttemptCounters(currentAttempt, input.counters),
      rejected: currentAttempt.rejected === null || input.counters.rejected === null
        ? null
        : currentAttempt.rejected + input.counters.rejected,
    };
    const cursorAfter = {
      ...asRecord(attempt.cursorAfter),
      [input.sourceId]: input.cursorAfter,
    };
    transaction.set(attemptReference, {
      counters: nextAttemptCounters,
      cursorAfter,
      updatedAt: committedAt,
    }, { merge: true });
    return { alreadyCommitted: false, record };
  });
}

export function reconcileSupplierSyncEvidence(
  job: SupplierSyncJobRecord,
  attempts: readonly SupplierSyncJobAttemptRecord[],
  pages: readonly SupplierSyncPageCommitRecord[],
  now = Date.now(),
): SupplierSyncReconciliationResult {
  const reconciledAt = new Date(now).toISOString();
  if (Number(job.evidenceVersion) !== SUPPLIER_SYNC_EVIDENCE_VERSION || attempts.length === 0) {
    return {
      status: "LEGACY_UNVERIFIED",
      issues: [],
      attemptCount: attempts.length,
      pageCommitCount: pages.length,
      cumulativeCounters: cumulativeFrom(job.cumulativeCounters),
      reconciledAt,
    };
  }
  const issues: SupplierSyncReconciliationIssue[] = [];
  const orderedAttempts = [...attempts].sort((left, right) => safeCount(left.attemptNumber) - safeCount(right.attemptNumber));
  const attemptIds = new Set<string>();
  orderedAttempts.forEach((attempt, index) => {
    if (attemptIds.has(attempt.attemptId) || safeCount(attempt.attemptNumber) !== index + 1) {
      issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: `Attempt numbering is not unique and contiguous at ${attempt.attemptId}.`, attemptId: attempt.attemptId });
    }
    attemptIds.add(attempt.attemptId);
  });
  if (safeCount(job.attemptCount) !== orderedAttempts.length) {
    issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: "Top-level attemptCount does not equal durable attempt records." });
  }
  orderedAttempts.forEach((attempt) => {
    const counters = countersFrom(attempt.counters);
    if (!terminalAttempt(attempt.status)) {
      issues.push({ category: "SYSTEM_ERROR", message: `Attempt ${attempt.attemptId} is not terminal.`, attemptId: attempt.attemptId });
    }
    if (!terminalEquation(counters)) {
      issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: `Attempt ${attempt.attemptId} terminal counters do not reconcile.`, attemptId: attempt.attemptId });
    }
  });
  const calculated = orderedAttempts.reduce<SupplierSyncCumulativeCounters>((total, attempt) => addCounters(total, countersFrom(attempt.counters)), emptyCounters());
  const stored = cumulativeFrom(job.cumulativeCounters);
  if (!stored || !countersEqual(calculated, stored)) {
    issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: "Attempt contributions do not equal top-level cumulative counters." });
  }
  if (stored && (stored.rejected === null || stored.processed !== stored.new + stored.changeCandidates + stored.unchanged + stored.rejected + stored.failed)) {
    issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: "Top-level processed terminal equation does not reconcile." });
  }
  const effectiveLimit = safeOptionalCount(job.effectiveTotalProductLimit);
  if (effectiveLimit !== null && stored && stored.processed > effectiveLimit) {
    issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: "Processed terminal outcomes exceed the effective job limit." });
  }
  const uniquePageIds = new Set<string>();
  const pageCounters = emptyCounters();
  pages.forEach((page) => {
    if (uniquePageIds.has(page.pageCommitId)) {
      issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: `Duplicate page commit ${page.pageCommitId}.`, pageCommitId: page.pageCommitId });
    }
    uniquePageIds.add(page.pageCommitId);
    if (page.status !== "committed") {
      issues.push({ category: "CHECKPOINT_ERROR", message: `Page commit ${page.pageCommitId} is not committed.`, pageCommitId: page.pageCommitId });
    }
    if (!attemptIds.has(page.attemptId)) {
      issues.push({ category: "SYSTEM_ERROR", message: `Page commit ${page.pageCommitId} references a missing attempt.`, pageCommitId: page.pageCommitId });
    }
    const pageResultCounters = countersFrom(page.counters);
    if (!terminalEquation(pageResultCounters)) {
      issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: `Page commit ${page.pageCommitId} terminal counters do not reconcile.`, pageCommitId: page.pageCommitId });
    }
    pageCounters.scanned += pageResultCounters.scanned;
    pageCounters.processed += pageResultCounters.processed;
    pageCounters.queued += pageResultCounters.queued;
    pageCounters.new += pageResultCounters.new;
    pageCounters.changeCandidates += pageResultCounters.changeCandidates;
    pageCounters.unchanged += pageResultCounters.unchanged;
    pageCounters.rejected = pageCounters.rejected === null || pageResultCounters.rejected === null
      ? null
      : pageCounters.rejected + pageResultCounters.rejected;
    pageCounters.failed += pageResultCounters.failed;
    pageCounters.warnings += pageResultCounters.warnings;
    pageCounters.pages += pageResultCounters.pages;
  });
  if (stored && stored.pages !== pages.length) {
    issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: "Durable page commit count does not equal cumulative page count." });
  }
  if (stored && !countersEqual(pageCounters, stored)) {
    issues.push({ category: "COUNTER_RECONCILIATION_ERROR", message: "Durable page contributions do not equal top-level cumulative counters." });
  }
  orderedAttempts.slice(1).forEach((attempt, index) => {
    const previous = orderedAttempts[index];
    const previousAfter = asRecord(previous.cursorAfter);
    const currentBefore = asRecord(attempt.cursorBefore);
    Object.keys(previousAfter).forEach((sourceId) => {
      if (Object.hasOwn(currentBefore, sourceId) && !sameNullableCursor(previousAfter[sourceId], currentBefore[sourceId])) {
        issues.push({ category: "CHECKPOINT_ERROR", message: `Cursor chain is not contiguous for ${sourceId}.`, attemptId: attempt.attemptId });
      }
    });
  });
  const firstBefore = asRecord(orderedAttempts[0]?.cursorBefore);
  const initial = asRecord(job.initialCursor);
  Object.keys(initial).forEach((sourceId) => {
    if (!Object.hasOwn(firstBefore, sourceId) || !sameNullableCursor(initial[sourceId], firstBefore[sourceId])) {
      issues.push({ category: "CHECKPOINT_ERROR", message: `Initial cursor evidence is inconsistent for ${sourceId}.` });
    }
  });
  const finalCursor = asRecord(job.finalCursor);
  const lastAfter = asRecord(orderedAttempts.at(-1)?.cursorAfter);
  Object.keys(finalCursor).forEach((sourceId) => {
    if (!Object.hasOwn(lastAfter, sourceId) || !sameNullableCursor(finalCursor[sourceId], lastAfter[sourceId])) {
      issues.push({ category: "CHECKPOINT_ERROR", message: `Final cursor evidence is inconsistent for ${sourceId}.` });
    }
  });
  return {
    status: issues.length === 0 ? "VERIFIED" : "ISSUES",
    issues,
    attemptCount: orderedAttempts.length,
    pageCommitCount: pages.length,
    cumulativeCounters: stored,
    reconciledAt,
  };
}

export async function reconcileSupplierSyncJob(
  db: Firestore,
  jobId: string,
  now = Date.now(),
): Promise<SupplierSyncReconciliationResult> {
  const jobSnapshot = await db.collection("supplier_sync_jobs").doc(jobId).get();
  if (!jobSnapshot.exists) {
    return {
      status: "ISSUES",
      issues: [{ category: "SYSTEM_ERROR", message: "Supplier sync job does not exist." }],
      attemptCount: 0,
      pageCommitCount: 0,
      cumulativeCounters: null,
      reconciledAt: new Date(now).toISOString(),
    };
  }
  const job = { id: jobSnapshot.id, ...jobSnapshot.data() } as SupplierSyncJobRecord;
  const [attemptSnapshot, pageSnapshot] = await Promise.all([
    db.collection("supplier_sync_jobs").doc(jobId).collection("attempts").get(),
    db.collection("supplier_sync_jobs").doc(jobId).collection("pages").get(),
  ]);
  const attempts = attemptSnapshot.docs.map((doc) => ({ attemptId: doc.id, jobId, ...doc.data() } as SupplierSyncJobAttemptRecord));
  const pages = pageSnapshot.docs.map((doc) => ({ pageCommitId: doc.id, jobId, ...doc.data() } as SupplierSyncPageCommitRecord));
  return reconcileSupplierSyncEvidence(job, attempts, pages, now);
}

/**
 * Read-only admin evidence projection. The raw page records remain server-side;
 * the UI receives only safe attempt summaries and the pure reconciliation result.
 */
export async function loadSupplierSyncEvidence(
  db: Firestore,
  job: SupplierSyncJobRecord,
  now = Date.now(),
): Promise<SupplierSyncEvidenceReadModel> {
  const jobReference = db.collection("supplier_sync_jobs").doc(job.id);
  const [attemptSnapshot, pageSnapshot] = await Promise.all([
    jobReference.collection("attempts").get(),
    jobReference.collection("pages").get(),
  ]);
  const attempts = attemptSnapshot.docs
    .map((doc) => ({ attemptId: doc.id, jobId: job.id, ...doc.data() } as SupplierSyncJobAttemptRecord))
    .sort((left, right) => safeCount(left.attemptNumber) - safeCount(right.attemptNumber));
  const pages = pageSnapshot.docs.map((doc) => ({ pageCommitId: doc.id, jobId: job.id, ...doc.data() } as SupplierSyncPageCommitRecord));
  const reconciliation = reconcileSupplierSyncEvidence(job, attempts, pages, now);
  return {
    evidenceVersion: Number.isSafeInteger(Number(job.evidenceVersion)) ? Number(job.evidenceVersion) : null,
    legacy: reconciliation.status === "LEGACY_UNVERIFIED",
    attempts: attempts.map(projectAttemptEvidence),
    reconciliation,
    issueGroups: buildEvidenceIssueGroups(reconciliation.issues, attempts, reconciliation.status !== "LEGACY_UNVERIFIED"),
  };
}

export async function recordSupplierSyncReconciliation(
  db: Firestore,
  jobId: string,
  workerId: string,
  leaseId: string,
  result: SupplierSyncReconciliationResult,
  now = Date.now(),
): Promise<void> {
  const reference = db.collection("supplier_sync_jobs").doc(jobId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() || {};
    if (!snapshot.exists || data.state !== "running" || data.leaseOwner !== workerId || data.leaseId !== leaseId) {
      throw new Error("Supplier sync job lease is no longer owned during reconciliation.");
    }
    transaction.set(reference, {
      reconciliationStatus: result.status,
      reconciliationIssues: result.issues,
      reconciliationAttemptCount: result.attemptCount,
      reconciliationPageCommitCount: result.pageCommitCount,
      reconciledAt: result.reconciledAt,
      updatedAt: new Date(now).toISOString(),
    }, { merge: true });
  });
}
