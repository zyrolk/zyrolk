import { createHash } from "node:crypto";
import { Firestore } from "firebase-admin/firestore";
import { getRuntimeConfig } from "../config";
import { adminDb } from "../firebase";
import { appLogger } from "../logging";

export const SUPPLIER_OPERATIONAL_ALERTS_COLLECTION = "supplier_operational_alerts";
export const SUPPLIER_OPERATIONAL_ALERT_EVENTS_COLLECTION = "supplier_operational_alert_events";

export const SUPPLIER_OPERATIONAL_ALERT_CATEGORIES = [
  "supplier_sync_failure",
  "dead_letter_created",
  "queue_age_threshold_exceeded",
  "queue_worker_failure",
  "scheduler_failure",
  "media_processing_failure",
  "storage_failure",
  "authentication_failure",
  "app_check_failure",
  "supplier_connection_failure",
] as const;

export type SupplierOperationalAlertCategory = typeof SUPPLIER_OPERATIONAL_ALERT_CATEGORIES[number];
export type SupplierOperationalAlertSeverity = "critical" | "high" | "medium" | "low";
export type SupplierOperationalAlertStatus = "open" | "acknowledged" | "resolved";

export interface SupplierOperationalAlertInput {
  category: SupplierOperationalAlertCategory;
  severity?: SupplierOperationalAlertSeverity;
  supplierId?: string | null;
  queueItemId?: string | null;
  jobId?: string | null;
  batchId?: string | null;
  message?: string;
  technicalMetadata?: Record<string, unknown>;
  dedupeScope?: string;
  now?: number;
}

export interface SupplierOperationalAlertActor {
  uid: string;
  email: string;
}

export interface SupplierOperationalAlertRecordResult {
  alertId: string;
  created: boolean;
  reopened: boolean;
  notified: boolean;
  status: SupplierOperationalAlertStatus;
}

const CATEGORY_PRESENTATION: Record<SupplierOperationalAlertCategory, { title: string; message: string }> = {
  supplier_sync_failure: {
    title: "Supplier synchronization failed",
    message: "A supplier synchronization failed and requires administrator attention.",
  },
  dead_letter_created: {
    title: "Product processing requires recovery",
    message: "A supplier product could not be processed after the permitted retries.",
  },
  queue_age_threshold_exceeded: {
    title: "Product review processing is delayed",
    message: "Supplier products have remained unprocessed beyond the operational threshold.",
  },
  queue_worker_failure: {
    title: "Product processing service failed",
    message: "The supplier product processing service failed and requires attention.",
  },
  scheduler_failure: {
    title: "Automatic synchronization scheduler failed",
    message: "The supplier synchronization scheduler failed to complete its work.",
  },
  media_processing_failure: {
    title: "Supplier media processing failed",
    message: "One or more supplier product images could not be processed.",
  },
  storage_failure: {
    title: "Supplier media storage failed",
    message: "Supplier product media could not be stored safely.",
  },
  authentication_failure: {
    title: "Supplier Hub authentication failed",
    message: "A protected Supplier Hub request could not be authenticated.",
  },
  app_check_failure: {
    title: "Supplier Hub application verification failed",
    message: "A protected Supplier Hub request failed application verification.",
  },
  supplier_connection_failure: {
    title: "Supplier connection failed",
    message: "A configured supplier connection could not be verified.",
  },
};

const SECRET_KEY_PATTERN = /authorization|cookie|password|secret|token|credential|api[-_]?key/iu;

const cleanText = (value: unknown, maximum: number): string => typeof value === "string"
  ? value.trim().replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").slice(0, maximum)
  : "";

const cleanId = (value: unknown): string => cleanText(value, 180).replace(/[^a-zA-Z0-9._:-]/gu, "-");

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character] || character));

const sanitizeTechnicalValue = (value: unknown, depth: number): unknown => {
  if (depth > 4) return "[maximum depth reached]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return cleanText(value, 1_000);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 25).map((entry) => sanitizeTechnicalValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
      .slice(0, 50)
      .map(([key, entry]) => [cleanText(key, 100), sanitizeTechnicalValue(entry, depth + 1)]));
  }
  return cleanText(String(value ?? ""), 1_000);
};

export function sanitizeSupplierAlertTechnicalMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return (sanitizeTechnicalValue(value || {}, 0) || {}) as Record<string, unknown>;
}

export function supplierOperationalAlertId(input: Pick<SupplierOperationalAlertInput,
  "category" | "supplierId" | "queueItemId" | "jobId" | "batchId" | "dedupeScope"
>): string {
  const supplierId = cleanId(input.supplierId);
  const queueItemId = cleanId(input.queueItemId);
  const fallbackScope = cleanId(input.dedupeScope)
    || (!supplierId && !queueItemId ? cleanId(input.jobId) || cleanId(input.batchId) || "global" : "");
  const identity = [input.category, supplierId, queueItemId, fallbackScope].join(":");
  return createHash("sha256").update(identity).digest("hex");
}

const notificationId = (alertId: string, generation: number, recipient: string): string => createHash("sha256")
  .update(`supplier-alert:${alertId}:${generation}:email:${recipient.toLowerCase()}`)
  .digest("hex");

const eventId = (alertId: string, generation: number, event: string): string => createHash("sha256")
  .update(`${alertId}:${generation}:${event}`)
  .digest("hex");

const validRecipient = (value: string): string => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim())
  ? value.trim().toLowerCase()
  : "";

export async function recordSupplierOperationalAlert(
  db: Firestore,
  input: SupplierOperationalAlertInput,
  options: { notificationEmail?: string } = {},
): Promise<SupplierOperationalAlertRecordResult> {
  const now = input.now ?? Date.now();
  const occurredAt = new Date(now).toISOString();
  const alertId = supplierOperationalAlertId(input);
  const alertReference = db.collection(SUPPLIER_OPERATIONAL_ALERTS_COLLECTION).doc(alertId);
  const severity = input.severity || "critical";
  const presentation = CATEGORY_PRESENTATION[input.category];
  const message = cleanText(input.message, 500) || presentation.message;
  const supplierId = cleanId(input.supplierId) || null;
  const queueItemId = cleanId(input.queueItemId) || null;
  const jobId = cleanId(input.jobId) || null;
  const batchId = cleanId(input.batchId) || null;
  const technicalMetadata = sanitizeSupplierAlertTechnicalMetadata(input.technicalMetadata);
  const recipient = validRecipient(options.notificationEmail || "");

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(alertReference);
    const existing = snapshot.exists ? snapshot.data() || {} : {};
    const previousStatus = String(existing.status || "").toLowerCase() as SupplierOperationalAlertStatus;
    const reopening = snapshot.exists && previousStatus === "resolved";
    const created = !snapshot.exists;
    const startsIncident = created || reopening;
    const generation = Math.max(0, Number(existing.incidentGeneration) || 0) + (startsIncident ? 1 : 0);
    const occurrenceCount = Math.max(0, Number(existing.occurrenceCount) || 0) + 1;
    const status: SupplierOperationalAlertStatus = startsIncident ? "open" : previousStatus === "acknowledged" ? "acknowledged" : "open";
    const alert = {
      alertId,
      severity,
      category: input.category,
      title: presentation.title,
      supplierId,
      queueItemId,
      jobId,
      batchId,
      firstOccurrence: startsIncident ? occurredAt : existing.firstOccurrence || occurredAt,
      lastOccurrence: occurredAt,
      status,
      assignedAdmin: startsIncident ? null : existing.assignedAdmin || null,
      message,
      technicalMetadata,
      occurrenceCount,
      incidentGeneration: generation,
      updatedAt: occurredAt,
      ...(created ? { createdAt: occurredAt } : {}),
      ...(reopening ? {
        reopenedAt: occurredAt,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolvedBy: null,
      } : {}),
    };
    transaction.set(alertReference, alert, { merge: true });

    if (startsIncident) {
      const openedEventId = eventId(alertId, generation, reopening ? "reopened" : "opened");
      transaction.create(db.collection(SUPPLIER_OPERATIONAL_ALERT_EVENTS_COLLECTION).doc(openedEventId), {
        eventId: openedEventId,
        alertId,
        category: input.category,
        severity,
        event: reopening ? "reopened" : "opened",
        previousStatus: reopening ? "resolved" : null,
        newStatus: "open",
        supplierId,
        queueItemId,
        jobId,
        batchId,
        occurredAt,
        incidentGeneration: generation,
      });
    }

    const shouldNotify = startsIncident && severity === "critical" && Boolean(recipient);
    if (shouldNotify) {
      const deliveryId = notificationId(alertId, generation, recipient);
      transaction.create(db.collection("notification_outbox").doc(deliveryId), {
        channel: "email",
        kind: "supplier_operational_alert",
        alertId,
        recipientHash: createHash("sha256").update(recipient).digest("hex"),
        status: "handed_off",
        provider: "firebase-trigger-email",
        attemptCount: 1,
        maxAttempts: 3,
        currentMailId: deliveryId,
        createdAt: occurredAt,
        handedOffAt: occurredAt,
      });
      transaction.create(db.collection("mail").doc(deliveryId), {
        to: [recipient],
        message: {
          subject: `[Critical] Zyro.lk Supplier Hub: ${presentation.title}`,
          text: `${presentation.title}\n\n${message}\n\nAlert ID: ${alertId}`,
          html: `<h2>${escapeHtml(presentation.title)}</h2><p>${escapeHtml(message)}</p><p><strong>Alert ID:</strong> ${escapeHtml(alertId)}</p>`,
        },
        metadata: {
          alertId,
          category: input.category,
          kind: "supplier_operational_alert",
          notificationId: deliveryId,
        },
      });
    }

    return { alertId, created, reopened: reopening, notified: shouldNotify, status };
  });
}

export async function transitionSupplierOperationalAlert(
  db: Firestore,
  alertIdValue: string,
  status: "acknowledged" | "resolved",
  actor?: SupplierOperationalAlertActor,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  const alertId = cleanId(alertIdValue);
  if (!alertId || alertId !== alertIdValue || alertId.length !== 64) throw new Error("Operational alert ID is invalid.");
  const reference = db.collection(SUPPLIER_OPERATIONAL_ALERTS_COLLECTION).doc(alertId);
  const occurredAt = new Date(now).toISOString();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const alert = snapshot.data() || {};
    const previousStatus = String(alert.status || "open") as SupplierOperationalAlertStatus;
    if (previousStatus === "resolved" || previousStatus === status) return { alertId, ...alert };
    const actorProjection = actor ? {
      uid: cleanId(actor.uid),
      email: cleanText(actor.email, 320).toLowerCase(),
    } : null;
    const patch = {
      status,
      updatedAt: occurredAt,
      ...(status === "acknowledged" ? {
        acknowledgedAt: occurredAt,
        acknowledgedBy: actorProjection,
        assignedAdmin: actorProjection,
      } : {
        resolvedAt: occurredAt,
        resolvedBy: actorProjection,
      }),
    };
    transaction.set(reference, patch, { merge: true });
    const generation = Math.max(1, Number(alert.incidentGeneration) || 1);
    const lifecycleEventId = createHash("sha256")
      .update(`${alertId}:${generation}:${status}:${occurredAt}:${actorProjection?.uid || "system"}`)
      .digest("hex");
    transaction.create(db.collection(SUPPLIER_OPERATIONAL_ALERT_EVENTS_COLLECTION).doc(lifecycleEventId), {
      eventId: lifecycleEventId,
      alertId,
      category: alert.category,
      severity: alert.severity,
      event: status,
      previousStatus,
      newStatus: status,
      supplierId: alert.supplierId || null,
      queueItemId: alert.queueItemId || null,
      jobId: alert.jobId || null,
      batchId: alert.batchId || null,
      actor: actorProjection,
      occurredAt,
      incidentGeneration: generation,
    });
    return { alertId, ...alert, ...patch };
  });
}

export async function recordSupplierOperationalAlertSafely(input: SupplierOperationalAlertInput): Promise<void> {
  try {
    await recordSupplierOperationalAlert(adminDb, input, { notificationEmail: getRuntimeConfig().adminEmail });
  } catch (error) {
    appLogger.error("Supplier operational alert could not be recorded.", {
      category: input.category,
      supplierId: cleanId(input.supplierId) || null,
      queueItemId: cleanId(input.queueItemId) || null,
      error,
    });
  }
}

export async function resolveSupplierOperationalAlertSafely(
  input: Pick<SupplierOperationalAlertInput, "category" | "supplierId" | "queueItemId" | "jobId" | "batchId" | "dedupeScope">,
): Promise<void> {
  try {
    await transitionSupplierOperationalAlert(adminDb, supplierOperationalAlertId(input), "resolved");
  } catch (error) {
    appLogger.error("Supplier operational alert could not be automatically resolved.", {
      category: input.category,
      supplierId: cleanId(input.supplierId) || null,
      queueItemId: cleanId(input.queueItemId) || null,
      error,
    });
  }
}
