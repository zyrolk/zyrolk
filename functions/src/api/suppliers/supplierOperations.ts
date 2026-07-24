import { AggregateField, Firestore, Timestamp } from "firebase-admin/firestore";

export const OPERATIONS_PAGE_LIMIT = 50;
export const OPERATIONS_MAX_PAGE_LIMIT = 100;

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

function readLimit(value: unknown): number {
  const parsed = Number(value || OPERATIONS_PAGE_LIMIT);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(OPERATIONS_MAX_PAGE_LIMIT, parsed)) : OPERATIONS_PAGE_LIMIT;
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
  const queueStates = ["queued", "leased", "processing", "review_pending", "approved", "rejected", "conflict", "retryable_failure", "dead_letter", "suppressed"];
  const [
    supplierSnapshot,
    historySnapshot,
    todayHistorySnapshot,
    approvalSnapshot,
    mediaTotalSnapshot,
    mediaReadySnapshot,
    mediaPublishedSnapshot,
    mediaBrokenSnapshot,
    mediaStorageSnapshot,
    mediaFailureCountSnapshot,
    mediaFailureSnapshot,
    mediaReuseSnapshot,
    missingImageSnapshot,
    mediaDurationSnapshot,
    ...stateCounts
  ] = await Promise.all([
    supplierSnapshotPromise,
    db.collection("supplier_sync_history").orderBy("createdAt", "desc").limit(50).get(),
    db.collection("supplier_sync_history").where("createdAt", ">=", todayIso).limit(500).get(),
    db.collection("supplier_approval_audit").where("timestamp", ">=", Timestamp.fromDate(today)).limit(500).get(),
    db.collection("supplier_media_assets").count().get(),
    db.collection("supplier_media_assets").where("imageStatus", "==", "ready").count().get(),
    db.collection("supplier_media_assets").where("imageStatus", "==", "published").count().get(),
    db.collection("supplier_media_assets").where("imageStatus", "==", "failed").count().get(),
    db.collection("supplier_media_assets").aggregate({ storageBytes: AggregateField.sum("fileSize") }).get(),
    db.collection("supplier_media_audit").where("event", "==", "supplier_media_failed").count().get(),
    db.collection("supplier_media_audit").where("event", "==", "supplier_media_failed").limit(500).get(),
    db.collection("supplier_media_audit").where("event", "==", "supplier_media_reused").count().get(),
    db.collection("supplier_review_queue").where("productValidation.missingFields", "array-contains", "images").count().get(),
    db.collection("supplier_media_audit").where("processingDurationMs", ">", 0).limit(500).get(),
    ...queueStates.map((state) => countState(db, state)),
  ]);
  const suppliers: DocumentRecord[] = supplierSnapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  } as DocumentRecord));
  const queueCounts = Object.fromEntries(queueStates.map((state, index) => [state, stateCounts[index]]));
  const approvalEvents = approvalSnapshot.docs.map((document) => document.data());
  const histories = historySnapshot.docs.map((document) => document.data());
  const publishedToday = approvalEvents.filter((event) => event.action === "approve" || event.action === "approved").length;
  const todayHistories = todayHistorySnapshot.docs.map((document) => document.data());
  const importedToday = todayHistories.reduce((sum, history) => sum + number(history.productsImported), 0);
  const updatedToday = todayHistories.reduce((sum, history) => sum + number(history.productsUpdated), 0);
  const mediaFailures = mediaFailureCountSnapshot.data().count;
  const storageFailures = mediaFailureSnapshot.docs.filter((document) => String(document.data().failureReason || "").toLowerCase().includes("storage")).length;
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
  const alerts = generateSupplierOperationsAlerts({ suppliers, queueCounts, mediaFailures, storageFailures });
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
      failedImports: number(queueCounts.retryable_failure) + number(queueCounts.dead_letter),
      failedApprovals: number(queueCounts.conflict),
    },
    suppliers: projectedSuppliers,
    queues: {
      ...queueCounts,
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
