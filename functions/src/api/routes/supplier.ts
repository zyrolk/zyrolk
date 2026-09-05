import * as express from "express";
import { ApiError, sendSupplierFailure } from "../errors";
import { requireSupplierHubAdmin } from "../middleware/supplierHubAdminAuth";
import { fetchSupplierProductsFromTarget } from "../suppliers/fetchSupplierProducts";
import {
  decideSupplierQueueItem,
  parseSupplierApprovalDraft,
  parseSupplierReviewQueueItemIds,
} from "../suppliers/supplierApproval";
import {
  executeSupplierReviewCleanup,
  previewSupplierReviewCleanup,
} from "../suppliers/supplierReviewCleanup";
import { appendSupplierAuditEvent, createSupplierAuditEvent } from "../suppliers/supplierAuditTrail";
import {
  loadSupplierOperationsAudit,
  loadSupplierOperationsHistory,
  loadSupplierOperationsQueue,
  loadSupplierOperationsSummary,
} from "../suppliers/supplierOperations";
import { SupplierRegistry } from "../suppliers/SupplierRegistry";
import { adminAuth, adminDb } from "../firebase";
import { appLogger } from "../logging";
import { getSupplierSyncSchedulerStatus } from "../../scheduled/supplierSync";
import { getSyncInvestigationPage, getRecentSyncInvestigations } from "../suppliers/supplierInvestigations";
import { recordSupplierInvestigationRequestMetric } from "../suppliers/supplierCloudMonitoring";
import { isLocalSupplierSyncWorkerRuntime, processSupplierSyncJob } from "../../scheduled/supplierSyncWorker";
import {
  createSupplierSyncJob,
  listSupplierSyncJobs,
  projectSupplierSyncJobForAdmin,
  requestSupplierSyncJobCancellation,
  requeueSupplierSyncJob,
  SupplierSyncJobRecord,
} from "../suppliers/supplierSyncJobs";
import {
  parseSupplierSyncRequest,
  resolveEnabledSupplierSyncSourceIds,
  validateSupplierSyncSources,
} from "../suppliers/supplierSyncRequest";
import {
  listSupplierQueuePage,
  SupplierReviewBusinessFilter,
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
import {
  configureSupplierProductOffer,
  listSupplierProductOffers,
  selectSupplierProductOffer,
} from "../suppliers/supplierOfferEngine";
import {
  recordSupplierOperationalAlertSafely,
  resolveSupplierOperationalAlertSafely,
  transitionSupplierOperationalAlert,
} from "../suppliers/supplierOperationalAlerts";
import {
  findSupplierAccount,
  promoteSupplierAccount,
  setSupplierAccountStatus,
} from "../suppliers/supplierAccountAdministration";

const readSourceIds = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError("sourceIds must be an array when provided.", 400);
  const sourceIds = [...new Set(value.map((sourceId) => typeof sourceId === "string" ? sourceId.trim() : "").filter(Boolean))];
  if (sourceIds.length > 100) throw new ApiError("sourceIds cannot contain more than 100 supplier sources.", 400);
  if (sourceIds.some((sourceId) => sourceId.includes("/") || sourceId.length > 160)) {
    throw new ApiError("sourceIds contains an invalid supplier source ID.", 400);
  }
  return sourceIds;
};

const readManualSupplierSyncRequest = async (
  body: unknown,
  options: { requireExplicitMode?: boolean; fallbackSourceIds?: readonly string[] } = {},
) => {
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const syncRequest = parseSupplierSyncRequest(input, { requireExplicitMode: options.requireExplicitMode });
  const requestedSourceIds = options.fallbackSourceIds?.length
    ? readSourceIds([...options.fallbackSourceIds])
    : readSourceIds(input.sourceIds);
  const sourceIds = requestedSourceIds.length
    ? requestedSourceIds
    : await resolveEnabledSupplierSyncSourceIds(adminDb);
  await validateSupplierSyncSources(adminDb, sourceIds, syncRequest);
  return { sourceIds, syncRequest };
};

const readQueueItemId = (value: unknown): string => {
  if (typeof value !== "string") throw new ApiError("A supplier review queue item ID is required.", 400);
  const id = value.trim();
  if (!id || id.length > 160 || id.includes("/")) throw new ApiError("The supplier review queue item ID is invalid.", 400);
  return id;
};

const readSyncJobId = (value: unknown): string => {
  if (typeof value !== "string") throw new ApiError("A supplier sync job ID is required.", 400);
  const id = value.trim();
  if (!id || id.length > 180 || id.includes("/")) throw new ApiError("The supplier sync job ID is invalid.", 400);
  return id;
};

const readOperationalAlertId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ApiError("The operational alert ID is invalid.", 400);
  }
  return value;
};

const readSupplierAccountId = (value: unknown): string => {
  if (typeof value !== "string") throw new ApiError("A Firebase Auth user UID is required.", 400);
  const uid = value.trim();
  if (!uid || uid.length > 128 || uid.includes("/")) throw new ApiError("The Firebase Auth user UID is invalid.", 400);
  return uid;
};

const readBoundedLimit = (value: unknown, fallback = 100, maximum = 200): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ApiError(`limit must be a whole number between 1 and ${maximum}.`, 400);
  }
  return parsed;
};

const readSupplierQueueView = (value: unknown): "review" | "import" | "changes" => {
  const view = typeof value === "string" ? value.trim().toLowerCase() : "review";
  if (view !== "review" && view !== "import" && view !== "changes") {
    throw new ApiError("Supplier queue view is invalid.", 400);
  }
  return view;
};

const readSupplierReviewQueueState = (value: unknown): "active" | "review_pending" | "conflict" | "approved" | "rejected" | "history" => {
  const state = typeof value === "string" ? value.trim().toLowerCase() : "active";
  if (!(["active", "review_pending", "conflict", "approved", "rejected", "history"] as const).includes(state as never)) {
    throw new ApiError("Supplier review queue status filter is invalid.", 400);
  }
  return state as "active" | "review_pending" | "conflict" | "approved" | "rejected" | "history";
};

const readSupplierReviewBusinessFilter = (value: unknown): SupplierReviewBusinessFilter | undefined => {
  if (value === undefined || value === "") return undefined;
  const filter = typeof value === "string" ? value.trim().toLowerCase() : "";
  const allowed: SupplierReviewBusinessFilter[] = [
    "new_products",
    "product_updates",
    "removed_products",
    "conflicts",
    "needs_attention",
    "approved_history",
  ];
  if (!allowed.includes(filter as SupplierReviewBusinessFilter)) {
    throw new ApiError("Supplier review business filter is invalid.", 400);
  }
  return filter as SupplierReviewBusinessFilter;
};

const startLocalSupplierSyncJob = (jobId: string): void => {
  if (!isLocalSupplierSyncWorkerRuntime()) return;
  void processSupplierSyncJob(jobId).catch((error) => {
    appLogger.error("Local supplier sync job execution failed.", { jobId, error });
  });
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
  if (result.success) {
    await resolveSupplierOperationalAlertSafely({ category: "supplier_connection_failure", supplierId: sourceId });
  } else {
    await recordSupplierOperationalAlertSafely({
      category: "supplier_connection_failure",
      severity: "critical",
      supplierId: sourceId,
      technicalMetadata: { sourceId, reason: result.error || "Connection test failed." },
    });
  }
  return result;
}

async function testProposedSupplierSource(sourceId: string, value: unknown) {
  const source = sanitizeSupplierSource(value);
  const connector = await SupplierRegistry.createConnectorForSourceRecord(sourceId, source, { allowProposedHost: true });
  const result = await connector.testConnection();
  if (!result.success) {
    await recordSupplierOperationalAlertSafely({
      category: "supplier_connection_failure",
      severity: "critical",
      supplierId: sourceId,
      technicalMetadata: { sourceId, reason: result.error || "Connection test failed." },
    });
    throw new ApiError(result.error || "Supplier connection test failed.", 422);
  }
  await resolveSupplierOperationalAlertSafely({
    category: "supplier_connection_failure",
    supplierId: sourceId,
  });
  return { source, result };
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
          expectedPendingRevision: req.body?.expectedPendingRevision,
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

  app.get("/api/supplier-accounts", requireSupplierHubAdmin, async (_req, res) => {
    try {
      const profiles = await adminDb.collection("supplier_profiles")
        .where("profileStatus", "==", "active")
        .limit(200)
        .get();
      const users = profiles.empty
        ? []
        : await adminDb.getAll(...profiles.docs.map((profile) => adminDb.collection("users").doc(profile.id)));
      const userById = new Map(users.filter((user) => user.exists).map((user) => [user.id, user.data() || {}]));
      const accounts = profiles.docs.flatMap((profile) => {
        const user = userById.get(profile.id);
        if (!user || user.role !== "supplier") return [];
        return [{
          id: profile.id,
          companyName: String(profile.data().companyName || "").slice(0, 160),
          email: String(user.email || "").slice(0, 320),
          profileStatus: "active",
        }];
      });
      res.status(200).json({ success: true, accounts });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier account listing failed.",
        fallbackMessage: "Active supplier accounts could not be loaded.",
        context: { route: "/api/supplier-accounts" },
      });
    }
  });

  app.get("/api/supplier-accounts/lookup", requireSupplierHubAdmin, async (req, res) => {
    try {
      const account = await findSupplierAccount(adminAuth, adminDb, req.query.query);
      res.status(200).json({ success: true, account });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier account lookup failed.",
        fallbackMessage: "The Firebase Auth user could not be found.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-accounts/:uid/promote", requireSupplierHubAdmin, async (req, res) => {
    try {
      const uid = readSupplierAccountId(req.params.uid);
      const result = await promoteSupplierAccount(adminAuth, adminDb, uid, reviewerFor(res));
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier account promotion failed.",
        fallbackMessage: "The customer account could not be promoted.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-accounts/:uid/activate", requireSupplierHubAdmin, async (req, res) => {
    try {
      const uid = readSupplierAccountId(req.params.uid);
      const result = await setSupplierAccountStatus(adminAuth, adminDb, uid, "active", reviewerFor(res));
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier account activation failed.",
        fallbackMessage: "The supplier account could not be activated.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-accounts/:uid/disable", requireSupplierHubAdmin, async (req, res) => {
    try {
      const uid = readSupplierAccountId(req.params.uid);
      const result = await setSupplierAccountStatus(adminAuth, adminDb, uid, "disabled", reviewerFor(res));
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier account disable failed.",
        fallbackMessage: "The supplier account could not be disabled.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-sync-investigation/:batchId", requireSupplierHubAdmin, async (req, res) => {
    try {
      const batchId = readSyncJobId(req.params.batchId);
      const limit = readBoundedLimit(req.query.limit ?? undefined, 100, 1000);
      const after = typeof req.query.after === 'string' ? req.query.after : undefined;
      recordSupplierInvestigationRequestMetric({ batchId, continuation: Boolean(after) });
      const result = await getSyncInvestigationPage(adminDb, batchId, { limit, afterId: after });
      const recent = await getRecentSyncInvestigations(adminDb, 25);
      res.status(200).json({ success: true, batchId, rows: result.rows, nextCursor: result.nextCursor, job: result.job || null, history: result.history || null, recent });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier sync investigation lookup failed.",
        fallbackMessage: "Supplier sync investigation data could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-sources", requireSupplierHubAdmin, async (req, res) => {
    let connectionVerified = false;
    try {
      const sourceId = cleanSupplierSourceId(req.body?.id);
      const reviewer = reviewerFor(res);
      const { source, result: connectionTest } = await testProposedSupplierSource(sourceId, req.body?.source);
      connectionVerified = true;
      await saveSupplierSource(adminDb, sourceId, source, reviewer, { createOnly: true });
      await adminDb.collection("supplierSources").doc(sourceId).set({
        connectionStatus: "connected",
        lastError: "None",
        lastConnectionTestAt: new Date().toISOString(),
      }, { merge: true });
      const startInitialSync = req.body?.startInitialSync !== false;
      const initialRequest = startInitialSync
        ? await readManualSupplierSyncRequest({ mode: "full" }, { fallbackSourceIds: [sourceId] })
        : null;
      const initialSync = initialRequest
        ? await createSupplierSyncJob(adminDb, {
          trigger: "manual",
          sourceIds: initialRequest.sourceIds,
          syncRequest: initialRequest.syncRequest,
          requestedBy: reviewer,
        })
        : null;
      const savedSource = await adminDb.collection("supplierSources").doc(sourceId).get();
      res.status(201).json({
        success: true,
        sourceId,
        source: { id: sourceId, ...projectSupplierSourceForAdmin(savedSource.data() || {}, sourceId) },
        connectionTest,
        accepted: startInitialSync,
        ...(initialSync ? {
          jobId: initialSync.job.id,
          job: projectSupplierSyncJobForAdmin(initialSync.job),
        } : {}),
      });
      if (initialSync?.created) startLocalSupplierSyncJob(initialSync.job.id);
    } catch (error: unknown) {
      if (!connectionVerified) {
        await recordSupplierOperationalAlertSafely({
          category: "supplier_connection_failure",
          severity: "critical",
          supplierId: typeof req.body?.id === "string" ? req.body.id : null,
          dedupeScope: typeof req.body?.id === "string" ? undefined : "supplier-onboarding",
          technicalMetadata: { reason: error instanceof Error ? error.message : String(error || "Supplier connection failed.") },
        });
      }
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

  app.get("/api/supplier-products/:productId/offers", requireSupplierHubAdmin, async (req, res) => {
    try {
      res.status(200).json({ success: true, ...(await listSupplierProductOffers(adminDb, req.params.productId)) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier offer listing failed.",
        fallbackMessage: "Supplier offers could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.patch("/api/supplier-products/:productId/offers/:offerId", requireSupplierHubAdmin, async (req, res) => {
    try {
      const result = await configureSupplierProductOffer(
        adminDb,
        req.params.productId,
        req.params.offerId,
        req.body?.offer,
        reviewerFor(res),
      );
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier offer configuration failed.",
        fallbackMessage: "Supplier offer could not be updated.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-products/:productId/offers/select", requireSupplierHubAdmin, async (req, res) => {
    try {
      const result = await selectSupplierProductOffer(
        adminDb,
        req.params.productId,
        req.body,
        reviewerFor(res),
      );
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Active supplier offer selection failed.",
        fallbackMessage: "The active supplier offer could not be changed.",
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

  app.get("/api/supplier-review-queue", requireSupplierHubAdmin, async (req, res) => {
    try {
      const view = readSupplierQueueView(req.query.view);
      const state = readSupplierReviewQueueState(req.query.state);
      const businessFilter = view === "review" ? readSupplierReviewBusinessFilter(req.query.filter) : undefined;
      const after = req.query.after === undefined ? undefined : readQueueItemId(req.query.after);
      const page = await listSupplierQueuePage(adminDb, {
        view,
        ...(view === "review" ? { state } : {}),
        ...(businessFilter ? { businessFilter } : {}),
        ...(after ? { after } : {}),
        limit: readBoundedLimit(req.query.limit, 50, 100),
      });
      res.status(200).json({ success: true, ...page });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier queue page lookup failed.",
        fallbackMessage: "Supplier queue items could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-review-queue/maintenance/prelaunch-cleanup", requireSupplierHubAdmin, async (_req, res) => {
    try {
      res.status(200).json({
        success: true,
        dryRun: true,
        preview: await previewSupplierReviewCleanup(adminDb),
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier Product Review cleanup preview failed.",
        fallbackMessage: "Supplier Product Review cleanup preview could not be generated.",
        context: { route: "/api/supplier-review-queue/maintenance/prelaunch-cleanup" },
      });
    }
  });

  app.post("/api/supplier-review-queue/maintenance/prelaunch-cleanup", requireSupplierHubAdmin, async (req, res) => {
    try {
      const result = await executeSupplierReviewCleanup(
        adminDb,
        req.body && typeof req.body === "object" ? req.body : {},
        reviewerFor(res),
      );
      res.status(result.failed > 0 ? 409 : 200).json({ success: result.failed === 0, ...result });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier Product Review cleanup failed.",
        fallbackMessage: "Supplier Product Review cleanup could not be completed.",
        context: { route: "/api/supplier-review-queue/maintenance/prelaunch-cleanup" },
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
          expectedPendingRevision: items[index]?.expectedPendingRevision,
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
      const items = Array.isArray(req.body?.items) ? req.body.items : null;
      const queueItemIds = parseSupplierReviewQueueItemIds(items
        ? items.map((item: Record<string, unknown>) => item?.queueItemId)
        : req.body?.queueItemIds);
      const reviewer = reviewerFor(res);
      const rejectionReason = req.body?.rejectionReason || "Bulk rejected by admin.";
      const results = [];
      for (let index = 0; index < queueItemIds.length; index += 1) {
        results.push(await decideSupplierQueueItem(adminDb, queueItemIds[index], "rejected", reviewer, {
          rejectionReason,
          expectedPendingRevision: items?.[index]?.expectedPendingRevision,
        }));
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
      const reviewer = reviewerFor(res);
      const manualRequest = await readManualSupplierSyncRequest(req.body, { requireExplicitMode: true });
      const result = await createSupplierSyncJob(adminDb, {
        trigger: "manual",
        sourceIds: manualRequest.sourceIds,
        syncRequest: manualRequest.syncRequest,
        requestedBy: reviewer,
      });
      res.status(202).json({
        success: true,
        accepted: true,
        created: result.created,
        deduplicated: !result.created,
        jobId: result.job.id,
        batchId: result.job.id,
        status: "Pending",
        job: projectSupplierSyncJobForAdmin(result.job),
      });
      if (result.created) startLocalSupplierSyncJob(result.job.id);
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier synchronization failed.",
        fallbackMessage: "Supplier synchronization could not be completed.",
        context: { route: "/api/supplier-sync" },
      });
    }
  });

  app.get("/api/supplier-sync/jobs", requireSupplierHubAdmin, async (req, res) => {
    try {
      const jobs = await listSupplierSyncJobs(adminDb, readBoundedLimit(req.query.limit, 20, 100));
      res.status(200).json({ success: true, jobs: jobs.map(projectSupplierSyncJobForAdmin) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier sync job lookup failed.",
        fallbackMessage: "Supplier synchronization jobs could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.get("/api/supplier-sync/jobs/:jobId", requireSupplierHubAdmin, async (req, res) => {
    try {
      const jobId = readSyncJobId(req.params.jobId);
      const snapshot = await adminDb.collection("supplier_sync_jobs").doc(jobId).get();
      if (!snapshot.exists) throw new ApiError("Supplier sync job was not found.", 404);
      res.status(200).json({
        success: true,
        job: projectSupplierSyncJobForAdmin({ id: snapshot.id, ...snapshot.data() } as SupplierSyncJobRecord),
      });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier sync job lookup failed.",
        fallbackMessage: "The supplier synchronization job could not be loaded.",
        context: { route: req.path },
      });
    }
  });

  app.post("/api/supplier-sync/jobs/:jobId/:action", requireSupplierHubAdmin, async (req, res) => {
    try {
      const jobId = readSyncJobId(req.params.jobId);
      const action = String(req.params.action || "").trim().toLowerCase();
      if (!["cancel", "retry", "resume"].includes(action)) throw new ApiError("Supplier sync job action is invalid.", 400);
      const reviewer = reviewerFor(res);
      const job = action === "cancel"
        ? await requestSupplierSyncJobCancellation(adminDb, jobId, reviewer.uid)
        : await requeueSupplierSyncJob(adminDb, jobId, action as "retry" | "resume", reviewer.uid);
      if (!job) throw new ApiError("Supplier sync job was not found.", 404);
      const expectedState = action === "cancel" ? ["running", "cancelled"] : ["pending"];
      if (!expectedState.includes(job.state)) throw new ApiError(`Supplier sync job cannot ${action} from its current state.`, 409);
      res.status(200).json({ success: true, job: projectSupplierSyncJobForAdmin(job) });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier sync job action failed.",
        fallbackMessage: "The supplier synchronization job could not be updated.",
        context: { route: req.path },
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
        const manualRequest = await readManualSupplierSyncRequest({ mode: "full" }, { fallbackSourceIds: [sourceId] });
        const result = await createSupplierSyncJob(adminDb, {
          trigger: "manual",
          sourceIds: manualRequest.sourceIds,
          syncRequest: manualRequest.syncRequest,
          requestedBy: reviewerFor(res),
        });
        res.status(202).json({
          success: true,
          accepted: true,
          created: result.created,
          deduplicated: !result.created,
          jobId: result.job.id,
          batchId: result.job.id,
          status: "Pending",
          job: projectSupplierSyncJobForAdmin(result.job),
        });
        if (result.created) startLocalSupplierSyncJob(result.job.id);
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
          expectedPendingRevision: items[index]?.expectedPendingRevision,
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

  app.post("/api/supplier-operations/alerts/:alertId/action", requireSupplierHubAdmin, async (req, res) => {
    try {
      const alertId = readOperationalAlertId(req.params.alertId);
      const requestedStatus = String(req.body?.status || "").trim().toLowerCase();
      if (requestedStatus !== "acknowledged" && requestedStatus !== "resolved") {
        throw new ApiError("Operational alert status must be acknowledged or resolved.", 400);
      }
      const reviewer = reviewerFor(res);
      const alert = await transitionSupplierOperationalAlert(adminDb, alertId, requestedStatus, reviewer);
      if (!alert) throw new ApiError("Operational alert was not found.", 404);
      res.status(200).json({ success: true, alert });
    } catch (error: unknown) {
      sendSupplierFailure(res, error, {
        logMessage: "Supplier operational alert update failed.",
        fallbackMessage: "Operational alert status could not be updated.",
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

      if (!result.success) {
        await recordSupplierOperationalAlertSafely({
          category: "supplier_connection_failure",
          severity: "critical",
          supplierId: typeof req.body?.sourceId === "string" ? req.body.sourceId : null,
          dedupeScope: typeof req.body?.sourceId === "string" ? undefined : "supplier-connection-test",
          technicalMetadata: { reason: result.error || "Supplier connection test failed." },
        });
      }

      res.status(200).json(result);
    } catch (error: any) {
      await recordSupplierOperationalAlertSafely({
        category: "supplier_connection_failure",
        severity: "critical",
        supplierId: typeof req.body?.sourceId === "string" ? req.body.sourceId : null,
        dedupeScope: typeof req.body?.sourceId === "string" ? undefined : "supplier-connection-test",
        technicalMetadata: { reason: error instanceof Error ? error.message : String(error || "Supplier connection failed.") },
      });
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
