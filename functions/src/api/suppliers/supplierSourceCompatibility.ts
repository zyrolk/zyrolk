import { SupplierSourceConfig, SupplierConnectorType } from "./types";

const DEFAULT_CAPABILITIES = ["catalog.fetch", "connection.test"];
const AUTHENTICATION_MODES = new Set(["none", "secret_manager", "basic", "api_key", "oauth2"]);

type SupplierSourceData = FirebaseFirestore.DocumentData;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && (typeof value !== "string" || Boolean(value.trim()));

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.trim() || fallback : fallback;

const normalizePriority = (value: unknown): number => {
  const priority = Number(value);
  return Number.isFinite(priority) ? Math.max(0, Math.min(Math.floor(priority), 10_000)) : 100;
};

const inferConnectorType = (value: unknown, source: { id: string; name: string; websiteUrl: string }): SupplierConnectorType => {
  const requested = text(value).toLowerCase();
  if (requested && requested !== "website") return requested;
  const identity = `${source.id} ${source.name} ${source.websiteUrl}`.toLowerCase();
  return identity.includes("a2z") ? "a2z" : "http";
};

const normalizeCapabilities = (value: unknown): string[] => {
  if (!Array.isArray(value)) return DEFAULT_CAPABILITIES;
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim()))];
};

/**
 * Converts both pre-Sprint 7 and registry-shaped documents into the canonical
 * runtime model. It is intentionally read-only: no source is required to be
 * reconnected before the migration has been run.
 */
export function normalizeSupplierSourceConfig(id: string, data: SupplierSourceData): SupplierSourceConfig {
  const settings = isRecord(data.settings) ? data.settings : {};
  const config = isRecord(data.config) ? data.config : {};
  const name = text(data.supplierName) || text(data.name) || id;
  const websiteUrl = text(data.websiteUrl) || text(config.targetUrl);
  const endpoint = text(data.endpoint) || text(config.apiEndpoint);
  const sourceStatus = text(data.sourceStatus, data.enabled === false ? "inactive" : "active").toLowerCase();
  const authentication = isRecord(data.authentication) ? data.authentication : {};
  const mode = text(authentication.mode, "secret_manager").toLowerCase();

  return {
    id,
    supplierId: text(data.supplierId, id),
    name,
    connectorType: inferConnectorType(data.connectorType ?? data.supplierType ?? data.type, { id, name, websiteUrl }),
    enabled: sourceStatus === "active" && data.enabled !== false,
    priority: normalizePriority(data.priority ?? settings.priority),
    currency: text(data.currency) || text(settings.currency) || "LKR",
    timezone: text(data.timezone) || text(settings.timezone) || "Asia/Colombo",
    syncSchedule: text(data.syncSchedule) || text(settings.autoSync) || "Off",
    authentication: {
      mode: AUTHENTICATION_MODES.has(mode) ? mode as SupplierSourceConfig["authentication"]["mode"] : "secret_manager",
      ...(typeof authentication.secretRef === "string" && authentication.secretRef.trim() ? { secretRef: authentication.secretRef.trim() } : {}),
      ...(typeof authentication.credentialProfile === "string" && authentication.credentialProfile.trim()
        ? { credentialProfile: authentication.credentialProfile.trim() }
        : {}),
    },
    capabilities: normalizeCapabilities(data.capabilities),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    websiteUrl,
    endpoint,
    raw: data,
  };
}

export interface SupplierSourceCompatibilityMigration {
  config: SupplierSourceConfig;
  patch: Record<string, unknown>;
  needsMigration: boolean;
}

/**
 * Builds a merge-only Sprint 7 compatibility patch. Existing settings, config,
 * credentials references, and legacy fields are never overwritten or removed.
 */
export function buildSupplierSourceCompatibilityMigration(
  id: string,
  data: SupplierSourceData,
  migratedAt = new Date().toISOString(),
): SupplierSourceCompatibilityMigration {
  const config = normalizeSupplierSourceConfig(id, data);
  const patch: Record<string, unknown> = {};
  const setIfMissing = (field: string, value: unknown): void => {
    if (!hasValue(data[field])) patch[field] = value;
  };

  setIfMissing("supplierId", config.supplierId);
  setIfMissing("supplierName", config.name);
  setIfMissing("name", config.name);
  setIfMissing("connectorType", config.connectorType);
  // Supplier sync historically treats website as the feed transport. Keep that
  // legacy contract while connectorType selects the concrete connector.
  if (!hasValue(data.supplierType) && !hasValue(data.type)) patch.supplierType = "website";
  setIfMissing("sourceStatus", config.enabled ? "active" : "inactive");
  if (data.enabled === undefined || data.enabled === null) patch.enabled = config.enabled;
  setIfMissing("priority", config.priority);
  setIfMissing("currency", config.currency);
  setIfMissing("timezone", config.timezone);
  setIfMissing("syncSchedule", config.syncSchedule);
  if (data.capabilities === undefined || data.capabilities === null) patch.capabilities = config.capabilities;
  if (!isRecord(data.authentication)) patch.authentication = config.authentication;
  if (config.websiteUrl) setIfMissing("websiteUrl", config.websiteUrl);
  if (config.endpoint) setIfMissing("endpoint", config.endpoint);

  if (Number(data.supplierRegistrySchemaVersion) !== 7) {
    patch.supplierRegistrySchemaVersion = 7;
    patch.supplierRegistryMigratedAt = migratedAt;
  }

  return { config, patch, needsMigration: Object.keys(patch).length > 0 };
}
