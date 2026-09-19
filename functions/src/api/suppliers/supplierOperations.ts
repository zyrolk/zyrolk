import { AggregateField, FieldPath, Firestore, Timestamp } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { reviewRecordIsActionable } from "../../scheduled/supplierReviewQueue";
import { SUPPLIER_OPERATIONAL_ALERT_CATEGORIES } from "./supplierOperationalAlerts";

export const OPERATIONS_PAGE_LIMIT = 50;
export const OPERATIONS_MAX_PAGE_LIMIT = 100;
export const OPERATIONAL_ALERTS_PAGE_LIMIT = 50;
export const OPERATIONAL_ALERTS_MAX_PAGE_LIMIT = 100;
const OPERATIONAL_ALERTS_SCAN_BATCH_SIZE = 100;
const OPERATIONAL_ALERTS_MAX_SCAN_PER_REQUEST = 5_000;

export type SupplierOperationalSeverity = "critical" | "high" | "medium" | "low";

export interface SupplierOperationsAlert {
  id: string;
  type: string;
  severity: SupplierOperationalSeverity;
  title: string;
  message: string;
  supplierId?: string;
  createdAt: string;
}

type DocumentRecord = Record<string, unknown> & { id: string };

const OPERATIONAL_ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
const OPERATIONAL_ALERT_CATEGORIES = SUPPLIER_OPERATIONAL_ALERT_CATEGORIES;
const OPERATIONAL_ALERT_SEVERITIES = ["critical", "high", "medium", "low"] as const;

const number = (value: unknown): number => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function toOperationsIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "object" && value !== null && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function calculateSupplierHealthScore(source: Record<string, unknown>, nowMs = Date.now()): number {
  if (source.enabled === false || String(source.sourceStatus || "").toLowerCase() === "inactive") return 0;
  const health = source.syncHealth && typeof source.syncHealth === "object"
    ? source.syncHealth as Record<string, unknown>
    : {};
  const successRate = Math.min(100, number(health.successRate));
  const lastSuccess = toOperationsIso(source.lastSuccessfulSyncAt || health.lastSuccessfulSyncAt || source.lastSync);
  const lastFailure = toOperationsIso(source.lastFailedSyncAt || health.lastFailedSyncAt);
  let score = successRate || (lastSuccess ? 80 : 50);
  if (String(source.connectionStatus || "").toLowerCase() === "failed") score -= 25;
  if (source.currentlySyncing === true) score += 2;
  if (lastFailure && (!lastSuccess || lastFailure > lastSuccess)) score -= 20;
  if (lastSuccess) {
    const ageHours = Math.max(0, nowMs - new Date(lastSuccess).getTime()) / 3_600_000;
    if (ageHours > 48) score -= 25;
    else if (ageHours > 24) score -= 10;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function generateSupplierOperationsAlerts(input: {
  suppliers: DocumentRecord[];
  queueCounts: Record<string, number>;
  mediaFailures: number;
  storageFailures: number;
  nowIso?: string;
}): SupplierOperationsAlert[] {
  const nowIso = input.nowIso || new Date().toISOString();
  const alerts: SupplierOperationsAlert[] = [];
  for (const supplier of input.suppliers) {
    const healthScore = calculateSupplierHealthScore(supplier, new Date(nowIso).getTime());
    const enabled = supplier.enabled !== false && String(supplier.sourceStatus || "active").toLowerCase() !== "inactive";
    const lastFailure = toOperationsIso(supplier.lastFailedSyncAt || (supplier.syncHealth as Record<string, unknown> | undefined)?.lastFailedSyncAt);
    const lastSuccess = toOperationsIso(supplier.lastSuccessfulSyncAt || (supplier.syncHealth as Record<string, unknown> | undefined)?.lastSuccessfulSyncAt);
    if (enabled && healthScore < 40) {
      alerts.push({ id: `supplier-offline:${supplier.id}`, type: "supplier_offline", severity: "critical", title: "Supplier requires attention", message: `${String(supplier.name || supplier.supplierName || supplier.id)} health is ${healthScore}%.`, supplierId: supplier.id, createdAt: nowIso });
    }
    if (enabled && lastFailure && (!lastSuccess || lastFailure > lastSuccess)) {
      alerts.push({ id: `sync-failure:${supplier.id}`, type: "sync_failure", severity: "high", title: "Latest sync failed", message: String(supplier.lastError || "The supplier's latest synchronization failed."), supplierId: supplier.id, createdAt: lastFailure });
    }
  }
  const pending = number(input.queueCounts.review_pending) + number(input.queueCounts.queued);
  if (pending >= 100) alerts.push({ id: "queue-backlog", type: "queue_backlog", severity: pending >= 500 ? "critical" : "high", title: "Review queue backlog", message: `${pending} products are waiting for review.`, createdAt: nowIso });
  const retries = number(input.queueCounts.retryable_failure) + number(input.queueCounts.dead_letter);
  if (retries >= 10) alerts.push({ id: "repeated-retries", type: "repeated_retries", severity: "high", title: "Repeated queue failures", message: `${retries} queue items require recovery.`, createdAt: nowIso });
  if (number(input.queueCounts.conflict) > 0) alerts.push({ id: "approval-conflicts", type: "approval_conflicts", severity: "medium", title: "Approval conflicts", message: `${number(input.queueCounts.conflict)} products need manual conflict resolution.`, createdAt: nowIso });
  if (input.mediaFailures > 0) alerts.push({ id: "media-failures", type: "media_failures", severity: "medium", title: "Media processing failures", message: `${input.mediaFailures} media operations failed.`, createdAt: nowIso });
  if (input.storageFailures > 0) alerts.push({ id: "storage-failures", type: "storage_failures", severity: "high", title: "Storage failures", message: `${input.storageFailures} storage operations failed.`, createdAt: nowIso });
  return alerts;
}

export function calculateOperationsPerformance(input: {
  syncDurations: number[];
  approvalDurations: number[];
  mediaDurations: number[];
  approvedCount: number;
  windowHours: number;
}): Record<string, number | null> {
  const average = (values: number[]): number | null => {
    const safe = values.filter((value) => Number.isFinite(value) && value >= 0);
    return safe.length ? Math.round(safe.reduce((sum, value) => sum + value, 0) / safe.length) : null;
  };
  return {
    queueThroughputPerHour: input.windowHours > 0 ? Math.round((number(input.approvedCount) / input.windowHours) * 100) / 100 : 0,
    averageSyncDurationMs: average(input.syncDurations),
    averageApprovalDurationMs: average(input.approvalDurations),
    averageMediaProcessingDurationMs: average(input.mediaDurations),
  };
}

export function isUnresolvedSupplierMediaFailure(record: Record<string, unknown>): boolean {
  const mediaStatus = String(record.mediaStatus || "").trim().toLowerCase();
  if (mediaStatus === "failed" || mediaStatus === "partial") return true;
  const queueState = String(record.queueState || "").trim().toLowerCase();
  return ["retryable_failure", "dead_letter"].includes(queueState)
    && /image|media|storage/iu.test(String(record.lastFailureReason || ""));
}

export function supplierMediaFailureMentionsStorage(record: Record<string, unknown>): boolean {
  const failureText = [
    record.lastFailureReason,
    ...(Array.isArray(record.mediaFailures) ? record.mediaFailures.map((failure) => (
      failure && typeof failure === "object" ? (failure as Record<string, unknown>).reason : failure
    )) : []),
  ].map(String).join(" ").toLowerCase();
  return failureText.includes("storage");
}

function readLimit(value: unknown): number {
  const parsed = Number(value || OPERATIONS_PAGE_LIMIT);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(OPERATIONS_MAX_PAGE_LIMIT, parsed)) : OPERATIONS_PAGE_LIMIT;
}

function readOperationalAlertQueryString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(`${label} must be provided exactly once.`, 400);
  }
  return value;
}

function readOperationalAlertLimit(value: unknown): number {
  const raw = readOperationalAlertQueryString(value, "limit");
  if (raw === undefined) return OPERATIONAL_ALERTS_PAGE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > OPERATIONAL_ALERTS_MAX_PAGE_LIMIT) {
    throw new ApiError(`limit must be a whole number between 1 and ${OPERATIONAL_ALERTS_MAX_PAGE_LIMIT}.`, 400);
  }
  return parsed;
}

function readOperationalAlertFilter<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] | undefined {
  const raw = readOperationalAlertQueryString(value, label);
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!allowed.includes(normalized as T[number])) {
    throw new ApiError(`${label} is invalid.`, 400);
  }
  return normalized as T[number];
}

function readOperationalAlertSupplierId(value: unknown): string | undefined {
  const raw = readOperationalAlertQueryString(value, "supplierId");
  if (raw === undefined) return undefined;
  const supplierId = raw.trim();
  if (!supplierId || supplierId.length > 180 || /[\u0000-\u001F\u007F/]/u.test(supplierId)) {
    throw new ApiError("supplierId is invalid.", 400);
  }
  return supplierId;
}

type OperationalAlertCursor = { version: 1; alertId: string };

export function encodeOperationalAlertCursor(alertId: string): string {
  return Buffer.from(JSON.stringify({ version: 1, alertId }), "utf8").toString("base64url");
}

function decodeOperationalAlertCursor(value: unknown): OperationalAlertCursor | undefined {
  const raw = readOperationalAlertQueryString(value, "after");
  if (raw === undefined) return undefined;
  if (raw.length > 512) throw new ApiError("Operational alert cursor is invalid.", 400);
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<OperationalAlertCursor>;
    if (parsed.version !== 1 || typeof parsed.alertId !== "string" || !parsed.alertId || parsed.alertId.includes("/")) {
      throw new Error("invalid cursor");
    }
    return { version: 1, alertId: parsed.alertId };
  } catch {
    throw new ApiError("Operational alert cursor is invalid.", 400);
  }
}

const sanitizedAlertText = (value: unknown, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").slice(0, maximum);
  return text || null;
};

const sanitizedAlertIdentifier = (value: unknown): string | null => {
  const text = sanitizedAlertText(value, 180);
  return text ? text.replace(/[^a-zA-Z0-9._:-]/gu, "-") : null;
};

export function projectSupplierOperationalAlertForAdmin(document: { id: string; data: () => Record<string, unknown> | undefined }): Record<string, unknown> {
  const alert = document.data() || {};
  return {
    id: document.id,
    alertId: document.id,
    status: sanitizedAlertText(alert.status, 32) || "open",
    severity: sanitizedAlertText(alert.severity, 32),
    category: sanitizedAlertText(alert.category, 80),
    supplierId: sanitizedAlertIdentifier(alert.supplierId),
    firstOccurrence: toOperationsIso(alert.firstOccurrence),
    lastOccurrence: toOperationsIso(alert.lastOccurrence),
    occurrenceCount: number(alert.occurrenceCount),
    incidentGeneration: number(alert.incidentGeneration),
    createdAt: toOperationsIso(alert.createdAt),
    updatedAt: toOperationsIso(alert.updatedAt),
    reopenedAt: toOperationsIso(alert.reopenedAt),
    acknowledgedAt: toOperationsIso(alert.acknowledgedAt),
    resolvedAt: toOperationsIso(alert.resolvedAt),
    title: sanitizedAlertText(alert.title, 180),
    message: sanitizedAlertText(alert.message, 1_000),
    queueItemId: sanitizedAlertIdentifier(alert.queueItemId),
    jobId: sanitizedAlertIdentifier(alert.jobId),
    batchId: sanitizedAlertIdentifier(alert.batchId),
  };
}

export async function loadSupplierOperationalAlerts(db: Firestore, options: {
  status?: unknown;
  category?: unknown;
  severity?: unknown;
  supplierId?: unknown;
  after?: unknown;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const limit = readOperationalAlertLimit(options.limit);
  const status = readOperationalAlertFilter(options.status, OPERATIONAL_ALERT_STATUSES, "status");
  const category = readOperationalAlertFilter(options.category, OPERATIONAL_ALERT_CATEGORIES, "category");
  const severity = readOperationalAlertFilter(options.severity, OPERATIONAL_ALERT_SEVERITIES, "severity");
  const supplierId = readOperationalAlertSupplierId(options.supplierId);
  const cursor = decodeOperationalAlertCursor(options.after);
  const collection = db.collection("supplier_operational_alerts");
  let query: FirebaseFirestore.Query = collection
    .orderBy("lastOccurrence", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (cursor) {
    const cursorSnapshot = await collection.doc(cursor.alertId).get();
    if (!cursorSnapshot.exists) throw new ApiError("Operational alert cursor is no longer valid.", 400);
    query = query.startAfter(cursorSnapshot);
  }

  const matched: Array<{ id: string; data: Record<string, unknown> }> = [];
  let scanned = 0;
  let hasMoreSource = false;
  let lastScannedId: string | null = null;
  while (matched.length < limit && scanned < OPERATIONAL_ALERTS_MAX_SCAN_PER_REQUEST) {
    const batchLimit = Math.min(OPERATIONAL_ALERTS_SCAN_BATCH_SIZE, OPERATIONAL_ALERTS_MAX_SCAN_PER_REQUEST - scanned);
    const snapshot = await query.limit(batchLimit).get();
    if (!snapshot.size) {
      hasMoreSource = false;
      break;
    }
    scanned += snapshot.size;
    let consumedAllBatch = true;
    for (let index = 0; index < snapshot.docs.length; index += 1) {
      const document = snapshot.docs[index];
      lastScannedId = document.id;
      const alert = document.data() as Record<string, unknown>;
      if (status && String(alert.status || "").toLowerCase() !== status) continue;
      if (category && String(alert.category || "").toLowerCase() !== category) continue;
      if (severity && String(alert.severity || "").toLowerCase() !== severity) continue;
      if (supplierId && String(alert.supplierId || "") !== supplierId) continue;
      matched.push({ id: document.id, data: alert });
      if (matched.length >= limit) {
        consumedAllBatch = index === snapshot.docs.length - 1;
        break;
      }
    }
    hasMoreSource = !consumedAllBatch || snapshot.size === batchLimit;
    if (matched.length >= limit || !hasMoreSource) break;
    query = query.startAfter(snapshot.docs.at(-1));
  }

  const hasMore = Boolean(hasMoreSource && lastScannedId);
  return {
    items: matched.map((document) => projectSupplierOperationalAlertForAdmin({ id: document.id, data: () => document.data })),
    nextCursor: hasMore ? encodeOperationalAlertCursor(lastScannedId as string) : null,
    hasMore,
    returnedCount: matched.length,
    scannedCount: scanned,
  };
}

async function countState(db: Firestore, state: string): Promise<number> {
  const snapshot = await db.collection("supplier_review_queue").where("queueState", "==", state).count().get();
  return snapshot.data().count;
}

export async function loadSupplierOperationsSummary(db: Firestore): Promise<Record<string, unknown>> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString();
  const supplierSnapshotPromise = db.collection("supplierSources").limit(1_000).get();
  const actionableStatusSnapshotPromise = db.collection("supplier_review_queue")
    .where("status", "in", ["Pending", "CONFLICT", "pending", "conflict", "Approved", "Rejected", "Suppressed", "Deleted", "Dismissed", "approved", "rejected", "suppressed", "deleted", "dismissed", "APPROVED", "REJECTED", "SUPPRESSED", "DELETED", "DISMISSED"])
    .select("status", "reviewStatus", "queueState", "decisionAction")
    .get();
  const actionableQueueStateSnapshotPromise = db.collection("supplier_review_queue")
    .where("queueState", "in", ["queued", "leased", "processing", "review_pending", "conflict", "retryable_failure", "dead_letter"])
    .select("status", "reviewStatus", "queueState", "decisionAction")
    .get();
  const queueStates = ["queued", "leased", "processing", "review_pending", "approved", "rejected", "conflict", "retryable_failure", "dead_letter", "suppressed"];
  const [
    supplierSnapshot,
    actionableStatusSnapshot,
    actionableQueueStateSnapshot,
    historySnapshot,
    todayHistorySnapshot,
    approvalSnapshot,
    mediaTotalSnapshot,
    mediaReadySnapshot,
    mediaPublishedSnapshot,
    mediaBrokenSnapshot,
    mediaStorageSnapshot,
    mediaFailureQueueSnapshot,
    mediaStatusFailureSnapshot,
    mediaReuseSnapshot,
    missingImageSnapshot,
    mediaDurationSnapshot,
    totalOfferSnapshot,
    approvedOfferSnapshot,
    updatedReviewSnapshot,
    removedReviewSnapshot,
    operationalAlertSnapshot,
    ...stateCounts
  ] = await Promise.all([
    supplierSnapshotPromise,
    actionableStatusSnapshotPromise,
    actionableQueueStateSnapshotPromise,
    db.collection("supplier_sync_history").orderBy("createdAt", "desc").limit(50).get(),
    db.collection("supplier_sync_history").where("createdAt", ">=", todayIso).limit(500).get(),
    db.collection("supplier_approval_audit").where("timestamp", ">=", Timestamp.fromDate(today)).limit(500).get(),
    db.collection("supplier_media_assets").count().get(),
    db.collection("supplier_media_assets").where("imageStatus", "==", "ready").count().get(),
    db.collection("supplier_media_assets").where("imageStatus", "==", "published").count().get(),
    db.collection("supplier_media_assets").where("imageStatus", "==", "failed").count().get(),
    db.collection("supplier_media_assets").aggregate({ storageBytes: AggregateField.sum("fileSize") }).get(),
    db.collection("supplier_review_queue").where("queueState", "in", ["retryable_failure", "dead_letter"]).limit(500).get(),
    db.collection("supplier_review_queue").where("mediaStatus", "in", ["failed", "partial"]).limit(500).get(),
    db.collection("supplier_media_audit").where("event", "==", "supplier_media_reused").count().get(),
    db.collection("supplier_review_queue").where("productValidation.missingFields", "array-contains", "images").count().get(),
    db.collection("supplier_media_audit").where("processingDurationMs", ">", 0).limit(500).get(),
    db.collection("supplier_product_offers").count().get(),
    db.collection("supplier_product_offers").where("reviewStatus", "==", "approved").count().get(),
    db.collection("supplier_review_queue").where("comparisonStatus", "in", [
      "PRICE_CHANGED",
      "STOCK_CHANGED",
      "DESCRIPTION_CHANGED",
      "IMAGE_CHANGED",
    ]).count().get(),
    db.collection("supplier_review_queue").where("comparisonStatus", "==", "SUPPLIER_OFFER_REMOVED").count().get(),
    db.collection("supplier_operational_alerts")
      .where("status", "in", ["open", "acknowledged"])
      .orderBy("lastOccurrence", "desc")
      .limit(100)
      .get(),
    ...queueStates.map((state) => countState(db, state)),
  ]);
  const suppliers: DocumentRecord[] = supplierSnapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  } as DocumentRecord));
  const queueCounts = Object.fromEntries(queueStates.map((state, index) => [state, stateCounts[index]]));
  const actionableQueueDocuments = new Map([
    ...actionableStatusSnapshot.docs,
    ...actionableQueueStateSnapshot.docs,
  ].map((document) => [document.id, document]));
  const actionableReviewCount = [...actionableQueueDocuments.values()]
    .filter((document) => reviewRecordIsActionable(document.data() as never)).length;
  const approvalEvents = approvalSnapshot.docs.map((document) => document.data());
  const histories = historySnapshot.docs.map((document) => document.data());
  const publishedToday = approvalEvents.filter((event) => event.action === "approve" || event.action === "approved").length;
  const todayHistories = todayHistorySnapshot.docs.map((document) => document.data());
  const importedToday = todayHistories.reduce((sum, history) => sum + number(history.productsImported), 0);
  const updatedToday = todayHistories.reduce((sum, history) => sum + number(history.productsUpdated), 0);
  const unresolvedMediaFailureDocuments = [...new Map([
    ...mediaFailureQueueSnapshot.docs.filter((document) => isUnresolvedSupplierMediaFailure(document.data())),
    ...mediaStatusFailureSnapshot.docs.filter((document) => isUnresolvedSupplierMediaFailure(document.data())),
  ].map((document) => [document.id, document])).values()];
  const mediaFailures = unresolvedMediaFailureDocuments.length;
  const storageFailures = unresolvedMediaFailureDocuments.filter((document) => supplierMediaFailureMentionsStorage(document.data())).length;
  const now = Date.now();
  const oldestQueue = await db.collection("supplier_review_queue")
    .where("queueState", "in", ["queued", "review_pending", "retryable_failure"])
    .orderBy("queueCreatedAt", "asc")
    .limit(1)
    .get();
  const oldestCreatedAt = toOperationsIso(oldestQueue.docs[0]?.data().queueCreatedAt || oldestQueue.docs[0]?.data().createdAt);
  const performance = calculateOperationsPerformance({
    syncDurations: histories.map((history) => number(history.durationMs)),
    approvalDurations: approvalEvents.map((event) => number(event.approvalLatencyMs)).filter(Boolean),
    mediaDurations: mediaDurationSnapshot.docs.map((document) => number(document.data().processingDurationMs)).filter(Boolean),
    approvedCount: publishedToday,
    windowHours: Math.max(1, (now - today.getTime()) / 3_600_000),
  });
  const projectedSuppliers = suppliers.map((supplier) => ({
    id: supplier.id,
    name: supplier.name || supplier.supplierName || supplier.id,
    enabled: supplier.enabled !== false,
    status: supplier.currentlySyncing ? "syncing" : supplier.enabled === false ? "disabled" : supplier.connectionStatus || "active",
    lastSync: toOperationsIso(supplier.lastSync),
    lastSuccess: toOperationsIso(supplier.lastSuccessfulSyncAt || (supplier.syncHealth as Record<string, unknown> | undefined)?.lastSuccessfulSyncAt),
    lastFailure: toOperationsIso(supplier.lastFailedSyncAt || (supplier.syncHealth as Record<string, unknown> | undefined)?.lastFailedSyncAt),
    failureReason: supplier.lastError || null,
    syncDurationMs: number((supplier.syncHealth as Record<string, unknown> | undefined)?.averageLatencyMs),
    productCount: number((supplier.catalogSyncMetrics as Record<string, unknown> | undefined)?.productsScanned),
    queueSize: number((supplier.syncMetrics as Record<string, unknown> | undefined)?.queueDepth),
    healthScore: calculateSupplierHealthScore(supplier),
    nextScheduledSync: toOperationsIso(supplier.nextScheduledSyncAt),
  }));
  const generatedAlerts = generateSupplierOperationsAlerts({ suppliers, queueCounts, mediaFailures, storageFailures });
  const durableAlerts = operationalAlertSnapshot.docs.map((document) => {
    const alert = document.data();
    return {
      id: document.id,
      type: alert.category || "operational_alert",
      severity: alert.severity || "critical",
      title: alert.title || "Supplier Hub alert",
      message: alert.message || "Supplier Hub requires administrator attention.",
      supplierId: alert.supplierId || undefined,
      createdAt: toOperationsIso(alert.firstOccurrence) || new Date().toISOString(),
      lastOccurrence: toOperationsIso(alert.lastOccurrence),
      status: alert.status || "open",
      assignedAdmin: alert.assignedAdmin || null,
    };
  });
  const alerts = [...durableAlerts, ...generatedAlerts.filter((alert) => !durableAlerts.some((durable) => durable.id === alert.id))];
  const processMemory = process.memoryUsage();
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalSuppliers: suppliers.length,
      activeSuppliers: suppliers.filter((source) => source.enabled !== false).length,
      disabledSuppliers: suppliers.filter((source) => source.enabled === false).length,
      lastSuccessfulSync: projectedSuppliers.map((source) => source.lastSuccess).filter(Boolean).sort().at(-1) || null,
      nextScheduledSync: projectedSuppliers.map((source) => source.nextScheduledSync).filter(Boolean).sort().at(0) || null,
      productsImportedToday: importedToday,
      productsUpdatedToday: updatedToday,
      productsPublishedToday: publishedToday,
      totalProducts: totalOfferSnapshot.data().count,
      pendingReview: actionableReviewCount,
      approvedProducts: approvedOfferSnapshot.data().count,
      updatedProducts: updatedReviewSnapshot.data().count,
      removedProducts: removedReviewSnapshot.data().count,
      failedImports: number(queueCounts.retryable_failure) + number(queueCounts.dead_letter),
      failedApprovals: number(queueCounts.conflict),
    },
    suppliers: projectedSuppliers,
    queues: {
      ...queueCounts,
      actionable: actionableReviewCount,
      pending: number(queueCounts.queued) + number(queueCounts.review_pending),
      retry: number(queueCounts.retryable_failure),
      queueAgeMs: oldestCreatedAt ? Math.max(0, now - new Date(oldestCreatedAt).getTime()) : 0,
    },
    media: {
      downloaded: mediaTotalSnapshot.data().count,
      ready: mediaReadySnapshot.data().count,
      published: mediaPublishedSnapshot.data().count,
      failedDownloads: mediaFailures,
      duplicateReuse: mediaReuseSnapshot.data().count,
      storageBytes: number(mediaStorageSnapshot.data().storageBytes),
      brokenImages: mediaBrokenSnapshot.data().count,
      missingImages: missingImageSnapshot.data().count,
    },
    alerts,
    performance: {
      ...performance,
      firestoreReads: null,
      firestoreWrites: null,
      activeWorkers: number(queueCounts.leased) + number(queueCounts.processing),
      retryBacklog: number(queueCounts.retryable_failure) + number(queueCounts.dead_letter),
      functionExecutionTimeMs: histories.length ? number(histories[0].durationMs) : null,
      functionMemory: { rssBytes: processMemory.rss, heapUsedBytes: processMemory.heapUsed },
      cloudMetricsAvailable: false,
    },
  };
}

export async function loadSupplierOperationsQueue(db: Firestore, options: {
  state?: string;
  search?: string;
  after?: string;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const limit = readLimit(options.limit);
  const scanLimit = Math.min(OPERATIONS_MAX_PAGE_LIMIT * 3, Math.max(limit * 3, limit));
  let query: FirebaseFirestore.Query = db.collection("supplier_review_queue").orderBy("queueCreatedAt", "desc");
  if (options.state && options.state !== "all") query = query.where("queueState", "==", options.state);
  if (options.after) {
    const cursor = await db.collection("supplier_review_queue").doc(options.after).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const snapshot = await query.limit(scanLimit).get();
  const search = String(options.search || "").trim().toLowerCase();
  const matched = snapshot.docs.filter((document) => {
    if (!search) return true;
    const data = document.data();
    return [document.id, data.productName, data.supplierCode, data.supplierName, data.sourceId]
      .some((value) => String(value || "").toLowerCase().includes(search));
  }).slice(0, limit);
  const dispositionSnapshots = matched.length
    ? await db.getAll(...matched.map((document) => db.collection("supplier_operation_error_states").doc(document.id)))
    : [];
  const dispositions = new Map(dispositionSnapshots.map((document) => [document.id, document.data()?.status || null]));
  return {
    items: matched.map((document) => {
      const data = document.data();
      return {
        id: document.id,
        productName: data.productName || data.productPayload?.name || "Unnamed product",
        supplierName: data.supplierName || data.sourceId || "Unknown supplier",
        sourceId: data.sourceId || null,
        supplierCode: data.supplierCode || null,
        state: data.queueState || String(data.status || "pending").toLowerCase(),
        createdAt: toOperationsIso(data.queueCreatedAt || data.createdAt),
        updatedAt: toOperationsIso(data.queueUpdatedAt || data.updatedAt),
        retryCount: number(data.retryCount),
        failureReason: data.lastFailureReason || data.failureReason || data.approvalConflict?.reason || null,
        stack: typeof data.failureStack === "string" ? data.failureStack.slice(0, 8_000) : null,
        errorDisposition: dispositions.get(document.id) || null,
      };
    }),
    nextCursor: snapshot.size === scanLimit ? snapshot.docs.at(-1)?.id || null : null,
  };
}

export async function loadSupplierOperationsHistory(db: Firestore, options: { after?: string; limit?: unknown }): Promise<Record<string, unknown>> {
  const limit = readLimit(options.limit);
  const collection = db.collection("supplier_sync_history");
  let query: FirebaseFirestore.Query = collection.orderBy("createdAt", "desc");
  if (options.after) {
    const cursor = await collection.doc(options.after).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const snapshot = await query.limit(limit).get();
  return {
    items: snapshot.docs.map((document) => ({ id: document.id, ...document.data() })),
    nextCursor: snapshot.size === limit ? snapshot.docs.at(-1)?.id || null : null,
  };
}

export async function loadSupplierOperationsAudit(db: Firestore, options: { after?: string; limit?: unknown }): Promise<Record<string, unknown>> {
  const limit = readLimit(options.limit);
  const definitions = [
    { key: "approval", collection: "supplier_approval_audit", timestampField: "timestamp" },
    { key: "mapping", collection: "supplier_mapping_audit", timestampField: "timestamp" },
    { key: "media", collection: "supplier_media_audit", timestampField: "timestamp" },
    { key: "sync", collection: "supplier_sync_history", timestampField: "createdAt" },
    { key: "supplier", collection: "supplier_operations_audit", timestampField: "timestamp" },
    { key: "alert", collection: "supplier_operational_alert_events", timestampField: "occurredAt" },
  ] as const;
  let cursors: Record<string, string> = {};
  if (options.after) {
    try {
      const parsed = JSON.parse(Buffer.from(options.after, "base64url").toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cursors = parsed;
    } catch {
      cursors = {};
    }
  }
  const pages = await Promise.all(definitions.map(async (definition) => {
    const collection = db.collection(definition.collection);
    let query: FirebaseFirestore.Query = collection.orderBy(definition.timestampField, "desc");
    const cursorId = cursors[definition.key];
    if (cursorId) {
      const cursor = await collection.doc(cursorId).get();
      if (cursor.exists) query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(limit).get();
    return snapshot.docs.map((document) => ({
      id: document.id,
      module: definition.key,
      ...document.data(),
      timestamp: toOperationsIso(document.data()[definition.timestampField]),
    }));
  }));
  const merged = pages.flat().sort((left, right) => String(right.timestamp || "").localeCompare(String(left.timestamp || "")));
  const items = merged.slice(0, limit);
  const nextCursors = { ...cursors };
  for (const definition of definitions) {
    const consumed = items.filter((item) => item.module === definition.key);
    if (consumed.length) nextCursors[definition.key] = consumed.at(-1)?.id || nextCursors[definition.key];
  }
  const hasMore = merged.length > limit || pages.some((page) => page.length === limit);
  return {
    items,
    nextCursor: hasMore ? Buffer.from(JSON.stringify(nextCursors)).toString("base64url") : null,
  };
}
