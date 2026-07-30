import { Firestore } from "firebase-admin/firestore";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

export interface SyncInvestigationRow {
  supplier: string;
  batchId: string;
  queueItemId: string;
  trigger: string | null;
  startTime: string | null;
  finishTime: string | null;
  currentStage: string | null;
  retryCount: number;
  safeErrorMessage: string | null;
  lastProcessedCursor: string | null;
  processingDurationMs: number | null;
  retryOutcome: string | null;
}

/**
 * Returns an investigation view for a supplier sync batch.
 * Does not modify any documents.
 */
export async function getSyncInvestigationPage(db: Firestore, batchId: string, opts?: { limit?: number; afterId?: string }): Promise<{ rows: SyncInvestigationRow[]; nextCursor: string | null; job?: Record<string, unknown>; history?: Record<string, unknown>; }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 2000));
  // Load job and history records if present
  const [jobSnap, historySnap] = await Promise.all([
    db.collection('supplier_sync_jobs').doc(batchId).get(),
    db.collection('supplier_sync_history').doc(batchId).get(),
  ]);
  const job = jobSnap.exists ? asRecord(jobSnap.data()) : null;
  const history = historySnap.exists ? asRecord(historySnap.data()) : null;
  const trigger = job ? String(job.trigger || job?.state || null) : history ? String(history.trigger || null) : null;
  const startTime = history?.startedAt ? String(history.startedAt) : job?.startedAt ? String(job.startedAt) : null;
  const finishTime = history?.finishedAt ? String(history.finishedAt) : job?.finishedAt ? String(job.finishedAt) : null;
  const retryOutcome = job ? String(job.state || null) : history ? String(history.status || null) : null;
  const safeErrorMessage = history?.errors && Array.isArray(history.errors) && history.errors.length > 0
    ? String(history.errors.slice(-1)[0])
    : history?.details ? String(history.details) : null;

  const sourceCursors = history?.sourceCursors && typeof history.sourceCursors === 'object' ? asRecord(history.sourceCursors) : {};

  let query: FirebaseFirestore.Query = db.collection('supplier_review_queue')
    .where('batchId', '==', batchId)
    .orderBy('createdAt', 'asc')
    .limit(limit + 1); // fetch one extra to detect nextCursor

  if (opts?.afterId) {
    // start after the document with id opts.afterId
    const afterDoc = await db.collection('supplier_review_queue').doc(opts.afterId).get();
    if (afterDoc.exists) query = query.startAfter(afterDoc);
  }

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  const rows: SyncInvestigationRow[] = docs.map((doc) => {
    const data = asRecord(doc.data());
    const sourceId = String(data.sourceId || data.supplierSourceId || '');
    const lastCursor = sourceId && Object.prototype.hasOwnProperty.call(sourceCursors, sourceId)
      ? String((sourceCursors as Record<string, unknown>)[sourceId] || '')
      : null;
    const created = data.createdAt ? String(data.createdAt) : (startTime || null);
    const completedAt = data.completedAt ? String(data.completedAt) : null;
    const processingDurationMs = created && completedAt ? (Date.parse(String(completedAt)) - Date.parse(String(created))) : null;
    return {
      supplier: String(data.supplierName || data.supplierId || data.supplier || '') || '',
      batchId,
      queueItemId: doc.id,
      trigger,
      startTime: created || startTime,
      finishTime: completedAt || finishTime,
      currentStage: String(data.queueState || data.status || null),
      retryCount: Number(data.retryCount || 0),
      safeErrorMessage: String(data.lastFailureReason || safeErrorMessage || '') || null,
      lastProcessedCursor: lastCursor,
      processingDurationMs: Number.isFinite(Number(processingDurationMs)) ? Number(processingDurationMs) : null,
      retryOutcome,
    };
  });

  const nextCursor = snapshot.docs.length > limit ? snapshot.docs[limit].id : null;
  return { rows, nextCursor, job: job || undefined, history: history || undefined };
}

export async function getRecentSyncInvestigations(db: Firestore, limit = 50): Promise<Record<string, unknown>[]> {
  const snapshot = await db.collection('supplier_sync_history').orderBy('createdAt', 'desc').limit(Math.max(1, Math.min(limit, 200))).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...asRecord(doc.data()) }));
}

export default getSyncInvestigationPage;
