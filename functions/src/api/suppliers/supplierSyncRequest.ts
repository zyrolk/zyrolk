import { createHash } from "node:crypto";
import { FieldPath, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { SupplierRegistry } from "./SupplierRegistry";
import { normalizeSupplierSourceConfig } from "./supplierSourceCompatibility";
import { resolveSupplierAccountSyncGuard, shouldValidateExternalSourceSupplierAccount } from "./supplierSyncAccountGuard";
import {
  SupplierCatalogFilterExecution,
  SupplierCatalogFilterRequest,
  SupplierConnectorSyncCapabilities,
  SupplierIncrementalCatalogRequest,
  SupplierSyncRequestControls,
} from "./types";

export const SUPPLIER_SYNC_PAGE_SIZE_MAX = 200;
export const SUPPLIER_SYNC_TOTAL_PRODUCT_LIMIT_MAX = 10_000;
const MAX_FILTER_TEXT_LENGTH = 160;
const MAX_SEARCH_LENGTH = 120;
const MAX_SOURCE_COUNT = 100;
const SOURCE_PAGE_SIZE = 100;
const MAX_COMPATIBILITY_SOURCE_PAGES = 10;

export type SupplierSyncRequest = SupplierSyncRequestControls;

const optionalText = (value: unknown, field: string, maximum: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${field} is too long.`);
  return normalized;
};

const optionalInteger = (value: unknown, field: string, maximum: number): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
};

/** Server-side normalization shared by API admission and worker execution. */
export function normalizeSupplierSyncRequest(value: unknown): SupplierSyncRequest {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const requestedMode = record.mode === undefined
    ? "full"
    : String(record.mode).trim().toLowerCase();
  if (requestedMode !== "full" && requestedMode !== "incremental") {
    throw new Error("Supplier sync mode must be full or incremental.");
  }
  const rawFilters = record.filters && typeof record.filters === "object" && !Array.isArray(record.filters)
    ? record.filters as Record<string, unknown>
    : {};
  const filters: SupplierCatalogFilterRequest = {
    category: optionalText(rawFilters.category, "Supplier category filter", MAX_FILTER_TEXT_LENGTH),
    subcategory: optionalText(rawFilters.subcategory, "Supplier subcategory filter", MAX_FILTER_TEXT_LENGTH),
    search: optionalText(rawFilters.search, "Supplier search filter", MAX_SEARCH_LENGTH),
  };
  Object.keys(filters).forEach((key) => {
    if (filters[key as keyof SupplierCatalogFilterRequest] === undefined) delete filters[key as keyof SupplierCatalogFilterRequest];
  });
  const pageSize = optionalInteger(record.pageSize, "Supplier sync page size", SUPPLIER_SYNC_PAGE_SIZE_MAX);
  const totalProductLimit = optionalInteger(
    record.totalProductLimit,
    "Supplier sync total product limit",
    SUPPLIER_SYNC_TOTAL_PRODUCT_LIMIT_MAX,
  );
  const continuationRaw = record.catalogContinuation === undefined
    ? undefined
    : String(record.catalogContinuation).trim().toLowerCase();
  const catalogContinuation = continuationRaw === "continue" || continuationRaw === "restart"
    ? continuationRaw
    : continuationRaw === undefined
      ? undefined
      : (() => { throw new Error("Supplier sync catalog continuation must be continue or restart."); })();
  return {
    mode: requestedMode,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(totalProductLimit !== undefined ? { totalProductLimit } : {}),
    ...(catalogContinuation ? { catalogContinuation } : {}),
  };
}

/** Stable scope identity prevents resuming a cursor under different controls. */
export function fingerprintSupplierSyncRequest(request: SupplierSyncRequest): string {
  const normalized = normalizeSupplierSyncRequest(request);
  return createHash("sha256").update(JSON.stringify({
    mode: normalized.mode,
    category: normalized.filters?.category || null,
    subcategory: normalized.filters?.subcategory || null,
    search: normalized.filters?.search || null,
    pageSize: normalized.pageSize || null,
    totalProductLimit: normalized.totalProductLimit || null,
  })).digest("hex");
}

export function supplierSyncRequestHasFilters(request: SupplierSyncRequest): boolean {
  return Boolean(request.filters?.category || request.filters?.subcategory || request.filters?.search);
}

interface SupplierCompletedCatalogBaseline {
  startedAt?: unknown;
  completedAt?: unknown;
  deltaToken?: unknown;
}

export interface SupplierIncrementalBaselineState {
  lastCompletedCatalogTraversal?: SupplierCompletedCatalogBaseline;
  lastCompletedIncrementalTraversal?: SupplierCompletedCatalogBaseline;
}

const baselineTimestampMs = (value: unknown): number | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    const parsed = Number(value.toMillis());
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

interface TrustedSupplierIncrementalBaseline {
  startedAtMs: number;
  completedAtMs: number;
  deltaToken: string | null;
}

const trustedCompletedBaseline = (
  value: SupplierCompletedCatalogBaseline | undefined,
): TrustedSupplierIncrementalBaseline | null => {
  const startedAtMs = baselineTimestampMs(value?.startedAt);
  const completedAtMs = baselineTimestampMs(value?.completedAt);
  if (startedAtMs === null || completedAtMs === null || completedAtMs < startedAtMs) return null;
  const deltaToken = typeof value?.deltaToken === "string" && value.deltaToken.trim()
    ? value.deltaToken.trim()
    : null;
  return { startedAtMs, completedAtMs, deltaToken };
};

/**
 * Produces a fail-closed native incremental contract. Completion timestamps are
 * never used as updated-since watermarks because that could lose changes made
 * while a prior traversal was still running.
 */
export function resolveSupplierIncrementalCatalogRequest(
  capabilities: Readonly<SupplierConnectorSyncCapabilities>,
  state: SupplierIncrementalBaselineState,
): SupplierIncrementalCatalogRequest {
  if (!capabilities.incremental.supported || capabilities.incremental.mechanism === "unsupported") {
    throw new Error("This supplier connector does not support true incremental synchronization.");
  }
  const baselines = [
    trustedCompletedBaseline(state.lastCompletedCatalogTraversal),
    trustedCompletedBaseline(state.lastCompletedIncrementalTraversal),
  ].filter((value): value is TrustedSupplierIncrementalBaseline => value !== null)
    .sort((left, right) => right.startedAtMs - left.startedAtMs || right.completedAtMs - left.completedAtMs);
  const newest = baselines[0];
  if (!newest) {
    throw new Error("Incremental synchronization requires a completed full or incremental traversal baseline.");
  }
  if (capabilities.incremental.mechanism === "updated_since") {
    return { updatedSince: new Date(newest.startedAtMs).toISOString() };
  }
  if (!newest.deltaToken) {
    throw new Error(`Incremental synchronization using ${capabilities.incremental.mechanism} requires a completed baseline token.`);
  }
  return { deltaToken: newest.deltaToken };
}

/** API boundary wrapper: unlike worker normalization, malformed input is a client error. */
export function parseSupplierSyncRequest(
  value: unknown,
  options: { requireExplicitMode?: boolean } = {},
): SupplierSyncRequest {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (options.requireExplicitMode && record.mode === undefined) {
    throw new ApiError("Manual synchronization mode is required.", 400);
  }
  if (record.filters !== undefined && (
    !record.filters
    || typeof record.filters !== "object"
    || Array.isArray(record.filters)
  )) {
    throw new ApiError("Synchronization filters are invalid.", 400);
  }
  try {
    return normalizeSupplierSyncRequest(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Synchronization options are invalid.";
    throw new ApiError(message, 400);
  }
}

const requireFilterCapability = (
  execution: SupplierCatalogFilterExecution,
  label: string,
  sourceId: string,
): void => {
  if (execution !== "unsupported") return;
  const message = `${label} is not supported by supplier source ${sourceId}.`;
  throw new ApiError(message, 422, message, {
    sourceId,
    capability: label,
    supported: false,
  });
};

export function validateSupplierSyncRequestCapabilities(
  request: SupplierSyncRequest,
  capabilities: Readonly<SupplierConnectorSyncCapabilities>,
  sourceId: string,
): void {
  if (request.mode === "incremental" && !capabilities.incremental.supported) {
    const message = `Incremental synchronization is not supported by supplier source ${sourceId}.`;
    throw new ApiError(message, 422, message, {
      sourceId,
      mode: "incremental",
      supported: false,
      mechanism: capabilities.incremental.mechanism,
    });
  }
  if (request.filters?.category) requireFilterCapability(capabilities.categoryFilter, "Category filtering", sourceId);
  if (request.filters?.subcategory) requireFilterCapability(capabilities.subcategoryFilter, "Subcategory filtering", sourceId);
  if (request.filters?.search) requireFilterCapability(capabilities.searchFilter, "Search filtering", sourceId);
}

export function supplierSyncRequestIsSubset(request: SupplierSyncRequest): boolean {
  return request.mode === "incremental"
    || Boolean(request.totalProductLimit)
    || supplierSyncRequestHasFilters(request);
}

export interface ValidatedSupplierSyncSource {
  id: string;
  connectorType: string;
  capabilities: Readonly<SupplierConnectorSyncCapabilities>;
}

/** Loads exact sources and applies the code-owned connector capability policy. */
export async function validateSupplierSyncSources(
  db: Firestore,
  sourceIds: readonly string[],
  request: SupplierSyncRequest,
): Promise<ValidatedSupplierSyncSource[]> {
  const cleanIds = [...new Set(sourceIds.map((id) => String(id || "").trim()).filter(Boolean))].sort();
  if (!cleanIds.length || cleanIds.length > MAX_SOURCE_COUNT) {
    throw new ApiError(`Select between one and ${MAX_SOURCE_COUNT} supplier sources.`, 400);
  }
  if (cleanIds.length > 1 && supplierSyncRequestIsSubset(request)) {
    throw new ApiError(
      "Filtered, incremental, or product-limited synchronization must target one supplier source at a time.",
      400,
    );
  }
  const snapshots = await Promise.all(cleanIds.map((sourceId) => db.collection("supplierSources").doc(sourceId).get()));
  const validated: ValidatedSupplierSyncSource[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const sourceId = cleanIds[index];
    if (!snapshot.exists) throw new ApiError(`Supplier source ${sourceId} was not found.`, 404);
    const source = normalizeSupplierSourceConfig(sourceId, snapshot.data() || {});
    if (!source.enabled) throw new ApiError(`Supplier source ${sourceId} is disabled or paused.`, 409);
    if (shouldValidateExternalSourceSupplierAccount(sourceId)) {
      const accountGuard = await resolveSupplierAccountSyncGuard(db, source.supplierAccountId);
      if (!accountGuard.allowed) {
        throw new ApiError(accountGuard.message, 409, accountGuard.message, {
          sourceId,
          profileStatus: accountGuard.status,
          supplierAccountId: String(source.supplierAccountId || "").trim() || null,
        });
      }
    }
    const capabilities = SupplierRegistry.getConnectorSyncCapabilities(source.connectorType);
    validateSupplierSyncRequestCapabilities(request, capabilities, sourceId);
    if (request.mode === "incremental") {
      try {
        resolveSupplierIncrementalCatalogRequest(capabilities, snapshot.data() || {});
      } catch (error) {
        const message = error instanceof Error ? error.message : "Incremental synchronization baseline is invalid.";
        throw new ApiError(message, 422, message, {
          sourceId,
          mode: "incremental",
          supported: capabilities.incremental.supported,
          mechanism: capabilities.incremental.mechanism,
        });
      }
    }
    validated.push({ id: sourceId, connectorType: source.connectorType, capabilities });
  }
  return validated;
}

/** Compatibility path for protected clients that historically omitted sourceIds. */
export async function resolveEnabledSupplierSyncSourceIds(db: Firestore): Promise<string[]> {
  const result: string[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (let page = 0; page < MAX_COMPATIBILITY_SOURCE_PAGES; page += 1) {
    let query = db.collection("supplierSources")
      .orderBy(FieldPath.documentId())
      .limit(SOURCE_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const document of snapshot.docs) {
      if (normalizeSupplierSourceConfig(document.id, document.data()).enabled) result.push(document.id);
    }
    if (snapshot.size < SOURCE_PAGE_SIZE) return result;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  throw new ApiError("Too many supplier sources were selected implicitly; select supplier sources explicitly.", 400);
}
