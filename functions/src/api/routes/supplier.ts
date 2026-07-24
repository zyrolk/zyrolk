import * as express from "express";
import { ApiError, sendSupplierFailure } from "../errors";
import { requireSupplierHubAdmin } from "../middleware/supplierHubAdminAuth";
import { fetchSupplierProductsFromTarget } from "../suppliers/fetchSupplierProducts";
import {
  decideSupplierQueueItem,
  parseSupplierApprovalDraft,
  parseSupplierReviewQueueItemIds,
} from "../suppliers/supplierApproval";
import { appendSupplierAuditEvent, createSupplierAuditEvent } from "../suppliers/supplierAuditTrail";
import {
  loadSupplierOperationsAudit,
  loadSupplierOperationsHistory,
  loadSupplierOperationsQueue,
  loadSupplierOperationsSummary,
} from "../suppliers/supplierOperations";
import { SupplierRegistry } from "../suppliers/SupplierRegistry";
import { adminDb } from "../firebase";
import { getSupplierSyncSchedulerStatus, runSupplierSync } from "../../scheduled/supplierSync";
import {
  processDueSupplierReviewQueueItems,
  recoverExpiredSupplierReviewQueueLeases,
  retryDeadLetterSupplierReviewQueueItem,
} from "../../scheduled/supplierReviewQueue";
import {
  cleanSupplierSourceId,
  projectSupplierSourceForAdmin,
  sanitizeSupplierSource,
  saveSupplierHubSettings,
  saveSupplierSource,
} from "../suppliers/supplierAdminConfiguration";

const readSourceIds = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError("sourceIds must be an array when provided.", 400);
  const sourceIds = [...new Set(value.map((sourceId) => typeof sourceId === "string" ? sourceId.trim() : "").filter(Boolean))];
  if (sourceIds.some((sourceId) => sourceId.includes("/") || sourceId.length > 160)) {
    throw new ApiError("sourceIds contains an invalid supplier source ID.", 400);
  }
  return sourceIds;
};

const readQueueItemId = (value: unknown): string => {
  if (typeof value !== "string") throw new ApiError("A supplier review queue item ID is required.", 400);
  const id = value.trim();
  if (!id || id.length > 160 || id.includes("/")) throw new ApiError("The supplier review queue item ID is invalid.", 400);
  return id;
};

const readBoundedLimit = (value: unknown, fallback = 100, maximum = 200): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ApiError(`limit must be a whole number between 1 and ${maximum}.`, 400);
  }
  return parsed;
};

async function testStoredSupplierSource(sourceId: string) {
  const reference = adminDb.collection("supplierSources").doc(sourceId);
  const sourceSnapshot = await reference.get();
  if (!sourceSnapshot.exists) throw new ApiError("Supplier source was not found.", 404);
  let result;
  try {
    const connector = await SupplierRegistry.createConnectorForSourceRecord(sourceId, sourceSnapshot.data() || {});
    result = await connector.testConnection();
  } catch (error) {
    result = {
      success: false,
      status: "Failed" as const,
      productsCount: 0,
      sampleProduct: null,
      error: error instanceof Error ? error.message : "Supplier connection test failed.",
    };
  }
  await reference.set({
    connectionStatus: result.success ? "connected" : "Failed",
    lastError: result.success ? "None" : result.error || "Connection test failed.",
    lastConnectionTestAt: new Date().toISOString(),
  }, { merge: true });
  return result;
}

export function registerSupplierRoutes(app: express.Express): void {
  const reviewerFor = (res: express.Response) => {
    const reviewer = res.locals.supplierAdmin as { uid?: unknown; email?: unknown } | undefined;
    if (typeof reviewer?.uid !== "string" || typeof reviewer.email !== "string") {
      throw new ApiError("Admin identity could not be verified.", 401);
    }
    return { uid: reviewer.uid, email: reviewer.email };
  };

  const decide = (action: "approved" | "rejected" | "deleted"): express.RequestHandler => async (req, res) => {
    try {
      const result = await decideSupplierQueueItem(
        adminDb,
        req.params.queueItemId,
        action,
        reviewerFor(res),
        {
          ...(action === "approved" ? { draft: parseSupplierApprovalDraft(req.body?.draft) } : {}),
          ...(action === "rejected" ? { rejectionReason: req.body?.rejectionReason } : {}),
          ...(action === "deleted" ? { deletionReason: req.body?.deletionReason } : {}),
          ...(action === "approved" ? { resolveConflict: req.body?.resolveConflict === true } : {}),
        },
      );
      res.status(result.success ? 200 : 409).json(result);
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: `Supplier queue ${action} failed.`,
        fallbackMessage: "Supplier review action could not be completed.",
        context: { route: req.path, action },
      });
    }
  };

  app.get("/api/supplier-sources", requireSupplierHubAdmin, async (_req, res) => {
    try {
      const sources = await adminDb.collection("supplierSources").get();
      res.status(200).json({
        success: true,
        sources: sources.docs.map((source) => ({ id: source.id, ...projectSupplierSourceForAdmin(source.data(), source.id) })),
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier source listing failed.",
        fallbackMessage: "Supplier sources could not be loaded.",
        context: { route: "/api/supplier-sources" },
      });
    }
  });

  app.post("/api/supplier-sources", requireSupplierHubAdmin, async (req, res) => {
    try {
      const sourceId = cleanSupplierSourceId(req.body?.id);
      await saveSupplierSource(adminDb, sourceId, req.body?.source, reviewerFor(res), { createOnly: true });
      const connectionTest = req.body?.testConnection === true
        ? await testStoredSupplierSource(sourceId)
        : undefined;
      const savedSource = await adminDb.collection("supplierSources").doc(sourceId).get();
      res.status(201).json({
        success: true,
        sourceId,
        source: { id: sourceId, ...projectSupplierSourceForAdmin(savedSource.data() || {}, sourceId) },
        ...(connectionTest ? { connectionTest } : {}),
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier source creation failed.",
        fallbackMessage: "Supplier source could not be created.",
        context: { route: req.path },
      });
    }
  });

  app.patch("/api/supplier-sources/:sourceId", requireSupplierHubAdmin, async (req, res) => {
    try {
      const sourceId = cleanSupplierSourceId(req.params.sourceId);
      const sourceSnapshot = await adminDb.collection("supplierSources").doc(sourceId).get();
      if (!sourceSnapshot.exists) throw new ApiError("Supplier source was not found.", 404);
      const current = projectSupplierSourceForAdmin(sourceSnapshot.data() || {}, sourceId);
      const requested = req.body?.source && typeof req.body.source === "object" ? req.body.source as Record<string, unknown> : {};
      await saveSupplierSource(adminDb, sourceId, {
        ...current,
        ...requested,
        config: { ...(current.config as Record<string, unknown> || {}), ...(requested.config as Record<string, unknown> || {}) },
        settings: { ...(current.settings as Record<string, unknown> || {}), ...(requested.settings as Record<string, unknown> || {}) },
      }, reviewerFor(res));
      res.status(200).json({ success: true, sourceId });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier source update failed.",
        fallbackMessage: "Supplier source could not be updated.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-settings", requireSupplierHubAdmin, async (req, res) => {
    try {
      await saveSupplierHubSettings(adminDb, req.body?.settings, reviewerFor(res));
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier Hub settings update failed.",
        fallbackMessage: "Supplier Hub settings could not be updated.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-review-queue/:queueItemId/approve", requireSupplierHubAdmin, decide("approved"));
  app.post("/api/supplier-review-queue/:queueItemId/reject", requireSupplierHubAdmin, decide("rejected"));
  app.post("/api/supplier-review-queue/:queueItemId/delete", requireSupplierHubAdmin, decide("deleted"));

  // The UI can use this endpoint for a chronological, server-authorized review
  // history without ever receiving permission to write audit records directly.
  app.get("/api/supplier-review-queue/:queueItemId/audit", requireSupplierHubAdmin, async (req, res) => {
    try {
      const queueItemId = readQueueItemId(req.params.queueItemId);
      const limit = readBoundedLimit(req.query.limit);
      const cursorId = req.query.after === undefined ? "" : readQueueItemId(req.query.after);
      const eventsReference = adminDb.collection("supplier_approval_audit");
      let historyQuery = eventsReference
        .where("queueItemId", "==", queueItemId)
        .orderBy("timestamp", "asc");
      if (cursorId) {
        const cursor = await eventsReference.doc(cursorId).get();
        if (!cursor.exists || cursor.data()?.queueItemId !== queueItemId) {
          throw new ApiError("Audit history cursor is invalid.", 400);
        }
        historyQuery = historyQuery.startAfter(cursor);
      }
      const history = await historyQuery.limit(limit).get();
      const events = history.docs.map((document) => ({ id: document.id, ...document.data() }));
      res.status(200).json({
        success: true,
        queueItemId,
        events,
        nextCursor: history.docs.length === limit ? history.docs.at(-1)?.id || null : null,
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier review audit history failed.",
        fallbackMessage: "Supplier review audit history could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-review-queue/bulk-approve", requireSupplierHubAdmin, async (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items)) throw new ApiError("Supplier review items are required.", 400);
      const queueItemIds = parseSupplierReviewQueueItemIds(items.map((item) => item?.queueItemId));
      const reviewer = reviewerFor(res);
      const results = [];
      for (let index = 0; index < queueItemIds.length; index += 1) {
        results.push(await decideSupplierQueueItem(adminDb, queueItemIds[index], "approved", reviewer, {
          draft: parseSupplierApprovalDraft(items[index]?.draft),
          resolveConflict: items[index]?.resolveConflict === true,
        }));
      }
      const hasConflict = results.some((result) => !result.success);
      res.status(hasConflict ? 409 : 200).json({ success: !hasConflict, results });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Bulk supplier queue approval failed.",
        fallbackMessage: "Bulk supplier approval could not be completed.",
        context: { route: req.path, action: "approved" },
      });
    }
  });

  app.post("/api/supplier-review-queue/bulk-reject", requireSupplierHubAdmin, async (req, res) => {
    try {
      const queueItemIds = parseSupplierReviewQueueItemIds(req.body?.queueItemIds);
      const reviewer = reviewerFor(res);
      const rejectionReason = req.body?.rejectionReason || "Bulk rejected by admin.";
      const results = [];
      for (const queueItemId of queueItemIds) {
        results.push(await decideSupplierQueueItem(adminDb, queueItemId, "rejected", reviewer, { rejectionReason }));
      }
      res.status(200).json({ success: true, results });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Bulk supplier queue rejection failed.",
        fallbackMessage: "Bulk supplier rejection could not be completed.",
        context: { route: req.path, action: "rejected" },
      });
    }
  });

  app.post("/api/supplier-review-queue/:queueItemId/retry", requireSupplierHubAdmin, async (req, res) => {
    try {
      const queueItemId = readQueueItemId(req.params.queueItemId);
      const queued = await retryDeadLetterSupplierReviewQueueItem(adminDb, queueItemId, undefined, reviewerFor(res));
      if (!queued) throw new ApiError("Only dead-letter or suppressed supplier review items can be retried.", 409);
      res.status(200).json({ success: true, queueItemId, state: "queued" });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier review queue retry failed.",
        fallbackMessage: "Supplier review item could not be retried.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-review-queue/resume", requireSupplierHubAdmin, async (req, res) => {
    try {
      const workerId = `admin-resume-${Date.now()}`;
      const reviewer = reviewerFor(res);
      const beforeSnapshot = await adminDb.collection("supplier_review_queue")
        .where("queueState", "in", ["queued", "retryable_failure", "leased", "processing"])
        .limit(150)
        .get();
      const previousStates = new Map(beforeSnapshot.docs.map((document) => [
        document.id,
        String(document.data().queueState || document.data().status || "unknown").toLowerCase(),
      ]));
      const recoveredLeases = await recoverExpiredSupplierReviewQueueLeases(adminDb);
      const results = await processDueSupplierReviewQueueItems(adminDb, workerId);
      for (const result of results.filter((item) => item.outcome !== "skipped")) {
        const currentSnapshot = await adminDb.collection("supplier_review_queue").doc(result.queueItemId).get();
        if (!currentSnapshot.exists) continue;
        const queueItem = currentSnapshot.data() || {};
        await appendSupplierAuditEvent(adminDb, {
          queueItemId: result.queueItemId,
          queueItem,
          action: "resume",
          previousState: previousStates.get(result.queueItemId) || "unknown",
          newState: String(queueItem.queueState || queueItem.status || result.state).toLowerCase(),
          admin: reviewer,
          workerId,
          reason: "Administrator resumed due supplier review queue work.",
        });
      }
      res.status(200).json({
        success: true,
        recoveredLeases,
        processed: results.filter((result) => result.outcome === "completed").length,
        retryableFailures: results.filter((result) => result.outcome === "retryable_failure").length,
        deadLetters: results.filter((result) => result.outcome === "dead_letter").length,
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier review queue recovery failed.",
        fallbackMessage: "Supplier review queue recovery could not be completed.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-sync", requireSupplierHubAdmin, async (req, res) => {
    try {
      const result = await runSupplierSync({
        trigger: "manual",
        sourceIds: readSourceIds(req.body?.sourceIds),
      });
      res.status(result.status === "Failed" ? 502 : 200).json({
        success: result.status !== "Failed",
        ...result,
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier synchronization failed.",
        fallbackMessage: "Supplier synchronization could not be completed.",
        context: { route: "/api/supplier-sync" },
      });
    }
  });

  app.get("/api/supplier-sync/status", requireSupplierHubAdmin, async (req, res) => {
    try {
      res.status(200).json({ success: true, ...(await getSupplierSyncSchedulerStatus()) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier scheduler status lookup failed.",
        fallbackMessage: "Supplier scheduler status could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-operations/summary", requireSupplierHubAdmin, async (req, res) => {
    try {
      res.status(200).json({ success: true, ...(await loadSupplierOperationsSummary(adminDb)) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations summary failed.",
        fallbackMessage: "Supplier operations could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-operations/queue", requireSupplierHubAdmin, async (req, res) => {
    try {
      res.status(200).json({ success: true, ...(await loadSupplierOperationsQueue(adminDb, {
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        after: typeof req.query.after === "string" ? req.query.after : undefined,
        limit: req.query.limit,
      })) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations queue lookup failed.",
        fallbackMessage: "Supplier queue metrics could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-operations/sync-history", requireSupplierHubAdmin, async (req, res) => {
    try {
      res.status(200).json({ success: true, ...(await loadSupplierOperationsHistory(adminDb, {
        after: typeof req.query.after === "string" ? req.query.after : undefined,
        limit: req.query.limit,
      })) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations sync history lookup failed.",
        fallbackMessage: "Supplier sync history could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-operations/audit", requireSupplierHubAdmin, async (req, res) => {
    try {
      res.status(200).json({ success: true, ...(await loadSupplierOperationsAudit(adminDb, {
        after: typeof req.query.after === "string" ? req.query.after : undefined,
        limit: req.query.limit,
      })) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations audit lookup failed.",
        fallbackMessage: "Supplier audit history could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-operations/suppliers/:sourceId/action", requireSupplierHubAdmin, async (req, res) => {
    try {
      const sourceId = cleanSupplierSourceId(req.params.sourceId);
      const action = String(req.body?.action || "").toLowerCase();
      if (!["sync", "retry", "pause", "resume", "disable"].includes(action)) {
        throw new ApiError("Supplier operation is invalid.", 400);
      }
      const sourceReference = adminDb.collection("supplierSources").doc(sourceId);
      const sourceSnapshot = await sourceReference.get();
      if (!sourceSnapshot.exists) throw new ApiError("Supplier source was not found.", 404);
      if (action === "sync" || action === "retry") {
        const result = await runSupplierSync({ trigger: "manual", sourceIds: [sourceId] });
        res.status(result.status === "Failed" ? 502 : 200).json({ success: result.status !== "Failed", ...result });
        return;
      }
      const enabled = action === "resume";
      const reviewer = reviewerFor(res);
      const operationAudit = adminDb.collection("supplier_operations_audit").doc();
      const batch = adminDb.batch();
      batch.set(sourceReference, {
        enabled,
        sourceStatus: enabled ? "active" : "inactive",
        operationalState: action === "pause" ? "paused" : action === "disable" ? "disabled" : "active",
        updatedAt: new Date().toISOString(),
        updatedBy: reviewer.uid,
      }, { merge: true });
      batch.create(operationAudit, {
        id: operationAudit.id,
        eventId: operationAudit.id,
        module: "supplier_source",
        action: `supplier_${action}`,
        supplierId: sourceSnapshot.data()?.supplierId || sourceId,
        sourceId,
        adminUserId: reviewer.uid,
        adminEmail: reviewer.email,
        timestamp: new Date().toISOString(),
      });
      await batch.commit();
      res.status(200).json({ success: true, sourceId, action });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations action failed.",
        fallbackMessage: "Supplier operation could not be completed.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-operations/queue/bulk-retry", requireSupplierHubAdmin, async (req, res) => {
    try {
      const queueItemIds = parseSupplierReviewQueueItemIds(req.body?.queueItemIds);
      const reviewer = reviewerFor(res);
      const results = [];
      for (const queueItemId of queueItemIds) {
        results.push({ queueItemId, queued: await retryDeadLetterSupplierReviewQueueItem(adminDb, queueItemId, undefined, reviewer) });
      }
      res.status(200).json({ success: true, results });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations bulk retry failed.",
        fallbackMessage: "Selected queue items could not be retried.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-operations/queue/bulk-reopen", requireSupplierHubAdmin, async (req, res) => {
    try {
      const queueItemIds = parseSupplierReviewQueueItemIds(req.body?.queueItemIds);
      const reviewer = reviewerFor(res);
      const results = [];
      for (const queueItemId of queueItemIds) {
        const reference = adminDb.collection("supplier_review_queue").doc(queueItemId);
        const reopened = await adminDb.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(reference);
          if (!snapshot.exists) return false;
          const item = snapshot.data() || {};
          const state = String(item.queueState || item.status || "").toLowerCase();
          if (!["rejected", "suppressed"].includes(state)) return false;
          transaction.set(reference, {
            queueState: "review_pending",
            status: "Pending",
            queueUpdatedAt: new Date().toISOString(),
            reopenedBy: reviewer.uid,
            reopenedAt: new Date().toISOString(),
          }, { merge: true });
          createSupplierAuditEvent(adminDb, transaction, {
            queueItemId,
            queueItem: item,
            action: "resume",
            previousState: state,
            newState: "review_pending",
            admin: reviewer,
            reason: "Administrator reopened the queue item for review.",
          });
          return true;
        });
        results.push({ queueItemId, reopened });
      }
      res.status(200).json({ success: true, results });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations bulk reopen failed.",
        fallbackMessage: "Selected queue items could not be reopened.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-operations/queue/bulk-resolve", requireSupplierHubAdmin, async (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items)) throw new ApiError("Conflict resolution items are required.", 400);
      const queueItemIds = parseSupplierReviewQueueItemIds(items.map((item) => item?.queueItemId));
      const reviewer = reviewerFor(res);
      const queueSnapshots = await adminDb.getAll(...queueItemIds.map((queueItemId) => adminDb.collection("supplier_review_queue").doc(queueItemId)));
      if (queueSnapshots.some((snapshot) => !snapshot.exists || String(snapshot.data()?.queueState || "").toLowerCase() !== "conflict")) {
        throw new ApiError("Bulk resolution is limited to approval conflicts.", 409);
      }
      const results = [];
      for (let index = 0; index < queueItemIds.length; index += 1) {
        results.push(await decideSupplierQueueItem(adminDb, queueItemIds[index], "approved", reviewer, {
          draft: parseSupplierApprovalDraft(items[index]?.draft),
          resolveConflict: true,
        }));
      }
      const hasConflict = results.some((result) => !result.success);
      res.status(hasConflict ? 409 : 200).json({ success: !hasConflict, results });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations bulk conflict resolution failed.",
        fallbackMessage: "Selected approval conflicts could not be resolved.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-operations/errors/:queueItemId/action", requireSupplierHubAdmin, async (req, res) => {
    try {
      const queueItemId = readQueueItemId(req.params.queueItemId);
      const action = String(req.body?.action || "").toLowerCase();
      if (!["ignore", "resolved"].includes(action)) throw new ApiError("Error center action is invalid.", 400);
      const queueSnapshot = await adminDb.collection("supplier_review_queue").doc(queueItemId).get();
      if (!queueSnapshot.exists) throw new ApiError("Supplier queue item was not found.", 404);
      const reviewer = reviewerFor(res);
      await adminDb.collection("supplier_operation_error_states").doc(queueItemId).set({
        queueItemId,
        status: action,
        updatedAt: new Date().toISOString(),
        updatedBy: reviewer.uid,
        updatedByEmail: reviewer.email,
      }, { merge: true });
      res.status(200).json({ success: true, queueItemId, status: action });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operations error disposition failed.",
        fallbackMessage: "Error center status could not be updated.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/test-supplier", requireSupplierHubAdmin, async (req, res) => {
    try {
      const sourceIdValue = req.body?.sourceId;
      const proposedSource = req.body?.source;
      let connector;

      if (sourceIdValue !== undefined) {
        const sourceId = cleanSupplierSourceId(sourceIdValue);
        const result = await testStoredSupplierSource(sourceId);
        res.status(200).json(result);
        return;
      } else if (proposedSource !== undefined) {
        const sourceId = cleanSupplierSourceId(req.body?.id);
        const source = sanitizeSupplierSource(proposedSource);
        connector = await SupplierRegistry.createConnectorForSourceRecord(sourceId, source, { allowProposedHost: true });
      } else {
        // Backward-compatible request shape for older clients and diagnostics.
        const websiteUrl = typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl.trim() : "";
        const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
        if (!websiteUrl) throw new ApiError("Website URL is required", 400);
        connector = await SupplierRegistry.createConnectorForTarget(websiteUrl, endpoint);
      }
      const result = await connector.testConnection();

      res.status(200).json(result);
    } catch (error: any) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier connection test failed.",
        fallbackMessage: "Supplier URL is not allowed.",
        fallbackStatusCode: 400,
        includeStatus: true,
        context: {
          route: "/api/test-supplier",
          sourceId: typeof req.body?.sourceId === "string" ? req.body.sourceId : undefined,
          websiteUrl: typeof req.body?.websiteUrl === "string" ? req.body.websiteUrl : undefined,
        },
      });
    }
  });

  app.post("/api/fetch-supplier", requireSupplierHubAdmin, async (req, res) => {
    const { websiteUrl, endpoint = "", productLimit } = req.body;

    if (!websiteUrl) {
      res.status(400).json({ error: "Website URL is required" });
      return;
    }

    try {
      const result = await fetchSupplierProductsFromTarget(websiteUrl, endpoint, productLimit);
      res.json({
        success: true,
        products: result.products,
        requestedProductLimit: result.requestedProductLimit,
      });
    } catch (error: any) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier catalog fetch failed.",
        fallbackMessage: "Failed to fetch from the supplier endpoint.",
        context: {
          route: "/api/fetch-supplier",
          websiteUrl,
          endpoint,
        },
      });
    }
  });
}
