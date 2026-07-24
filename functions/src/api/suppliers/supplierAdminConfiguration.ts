import { FieldValue, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { SupplierHubAdminIdentity } from "../middleware/supplierHubAdminAuth";
import { normalizeSupplierSourceConfig } from "./supplierSourceCompatibility";

const MAX_ID_LENGTH = 160;
const MAX_TEXT_LENGTH = 2_000;
const SOURCE_TYPES = new Set(["a2z", "api", "csv", "http", "rest", "shopify", "website", "whatsapp", "woocommerce", "xml"]);
const AUTO_SYNC_VALUES = new Set(["Off", "15 minutes", "30 minutes", "1 hour", "6 hours", "daily"]);
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "apikey", "apiheaders", "apitoken", "authorization", "bearertoken", "clientsecret", "cookie", "password", "secret", "token", "username",
]);

const omitCredentialFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(omitCredentialFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !FORBIDDEN_CREDENTIAL_KEYS.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase()) && key !== "apiHeaders")
    .map(([key, nested]) => [key, omitCredentialFields(nested)]));
};

/** Safe browser projection. It protects older documents until their credential cleanup runs. */
export function projectSupplierSourceForAdmin(value: Record<string, unknown>, sourceId = ""): Record<string, unknown> {
  const projected = omitCredentialFields(value) as Record<string, unknown>;
  if (!sourceId) return projected;
  const normalized = normalizeSupplierSourceConfig(sourceId, projected as FirebaseFirestore.DocumentData);
  return {
    ...projected,
    supplierId: normalized.supplierId,
    supplierName: projected.supplierName || normalized.name,
    name: projected.name || normalized.name,
    connectorType: normalized.connectorType,
    sourceStatus: projected.sourceStatus || (normalized.enabled ? "active" : "inactive"),
    enabled: normalized.enabled,
    priority: normalized.priority,
    currency: normalized.currency,
    timezone: normalized.timezone,
    syncSchedule: normalized.syncSchedule,
    capabilities: projected.capabilities || normalized.capabilities,
    websiteUrl: projected.websiteUrl || normalized.websiteUrl,
    endpoint: projected.endpoint || normalized.endpoint,
  };
}

const cleanText = (value: unknown, field: string, maximum = MAX_TEXT_LENGTH, required = false): string => {
  if (typeof value !== "string") {
    if (required) throw new ApiError(`${field} is required.`, 400);
    return "";
  }
  const result = value.trim();
  if ((required && !result) || result.length > maximum) throw new ApiError(`${field} is invalid.`, 400);
  return result;
};

export const cleanSupplierSourceId = (value: unknown): string => {
  const id = cleanText(value, "Supplier source ID", MAX_ID_LENGTH, true);
  if (id.includes("/")) throw new ApiError("Supplier source ID is invalid.", 400);
  return id;
};

const cleanHttpUrl = (value: unknown, field: string, required = false): string => {
  const url = cleanText(value, field, MAX_TEXT_LENGTH, required);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
    if (parsed.username || parsed.password) throw new Error("credentials prohibited");
    return parsed.toString();
  } catch {
    throw new ApiError(`${field} must be a valid HTTP or HTTPS URL without embedded credentials.`, 400);
  }
};

const cleanStringList = (value: unknown, field: string, maximumItems: number, maximumLength: number): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw new ApiError(`${field} is invalid.`, 400);
  return [...new Set(value.map((item) => cleanText(item, field, maximumLength)).filter(Boolean))];
};

const assertNoCredentialValues = (value: unknown, path = "source"): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialValues(item, `${path}[${index}]`));
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, nested]) => {
    if (FORBIDDEN_CREDENTIAL_KEYS.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())) {
      throw new ApiError(`${path}.${key} must not store credentials. Use a Secret Manager reference.`, 400);
    }
    assertNoCredentialValues(nested, `${path}.${key}`);
  });
};

const cleanConfig = (value: unknown): Record<string, string> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Supplier source config is invalid.", 400);
  assertNoCredentialValues(value, "config");
  const config = value as Record<string, unknown>;
  const allowed = [
    "description", "targetUrl", "apiEndpoint", "cssPriceSelector", "cssStockSelector", "cssImageSelector",
    "apiMethod", "apiDataPath", "whatsappNumber", "whatsappSender", "whatsappKeywords", "whatsappFormat",
  ];
  const result: Record<string, string> = {};
  for (const field of allowed) {
    const item = cleanText(config[field], `config.${field}`, MAX_TEXT_LENGTH);
    if (item) result[field] = item;
  }
  if (result.targetUrl) result.targetUrl = cleanHttpUrl(result.targetUrl, "config.targetUrl");
  if (result.apiEndpoint) result.apiEndpoint = cleanHttpUrl(result.apiEndpoint, "config.apiEndpoint");
  if (result.apiMethod && !["GET", "POST"].includes(result.apiMethod.toUpperCase())) {
    throw new ApiError("config.apiMethod must be GET or POST.", 400);
  }
  return result;
};

const cleanSettings = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Supplier source settings are invalid.", 400);
  assertNoCredentialValues(value, "settings");
  const settings = value as Record<string, unknown>;
  const autoSync = cleanText(settings.autoSync, "settings.autoSync", 30) || "Off";
  if (!AUTO_SYNC_VALUES.has(autoSync)) throw new ApiError("settings.autoSync is invalid.", 400);
  const productLimit = cleanText(settings.productLimit, "settings.productLimit", 20) || "All";
  if (productLimit !== "All" && (!Number.isInteger(Number(productLimit)) || Number(productLimit) < 1 || Number(productLimit) > 250)) {
    throw new ApiError("settings.productLimit is invalid.", 400);
  }
  const booleanFields = ["syncNewProducts", "syncPriceUpdates", "syncStockUpdates", "syncDescriptionUpdates", "syncImageUpdates", "dryRunMode"];
  const result: Record<string, unknown> = {
    categoriesFilter: cleanStringList(settings.categoriesFilter, "settings.categoriesFilter", 100, 160),
    brandFilter: cleanText(settings.brandFilter, "settings.brandFilter", 1_000),
    productLimit,
    autoSync,
  };
  for (const field of booleanFields) {
    if (settings[field] !== undefined) {
      if (typeof settings[field] !== "boolean") throw new ApiError(`settings.${field} is invalid.`, 400);
      result[field] = settings[field];
    }
  }
  return result;
};

const isMigratedLegacyA2ZSource = (value: FirebaseFirestore.DocumentData | undefined): boolean => {
  if (!value || Number(value.supplierRegistrySchemaVersion) !== 7 || !value.supplierRegistryMigratedAt) return false;
  return normalizeSupplierSourceConfig(String(value.supplierId || "legacy-supplier"), value).connectorType === "a2z";
};

const cleanAuthentication = (value: unknown, allowGlobalA2ZSecrets = false): Record<string, string> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Supplier authentication metadata is invalid.", 400);
  const authentication = value as Record<string, unknown>;
  assertNoCredentialValues(Object.fromEntries(Object.entries(authentication).filter(([key]) => !["secretRef", "credentialProfile"].includes(key))), "authentication");
  const mode = cleanText(authentication.mode, "authentication.mode", 30) || "secret_manager";
  if (!["none", "secret_manager", "basic", "api_key", "oauth2"].includes(mode)) throw new ApiError("authentication.mode is invalid.", 400);
  const secretRef = cleanText(authentication.secretRef, "authentication.secretRef", 300);
  const credentialProfile = cleanText(authentication.credentialProfile, "authentication.credentialProfile", 160);
  if (mode !== "none" && !secretRef && !credentialProfile && !allowGlobalA2ZSecrets) {
    throw new ApiError("A Secret Manager reference or credential profile is required for supplier authentication.", 400);
  }
  return { mode, ...(secretRef ? { secretRef } : {}), ...(credentialProfile ? { credentialProfile } : {}) };
};

export interface SanitizedSupplierSource {
  supplierName: string;
  name: string;
  supplierType: string;
  connectorType: string;
  websiteUrl: string;
  endpoint: string;
  sourceStatus: "active" | "inactive";
  enabled: boolean;
  priority: number;
  currency: string;
  timezone: string;
  syncSchedule: string;
  capabilities: string[];
  authentication: Record<string, string>;
  config: Record<string, string>;
  settings: Record<string, unknown>;
}

export function addSupplierSourceToConfiguredScope(
  settings: FirebaseFirestore.DocumentData | undefined,
  sourceId: string,
): string[] | null {
  if (settings?.enabledSupplierIdsConfigured !== true) return null;
  const currentIds = Array.isArray(settings.enabledSupplierIds)
    ? settings.enabledSupplierIds.filter((value: unknown): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  if (currentIds.includes(sourceId)) return currentIds;
  if (currentIds.length >= 1_000) throw new ApiError("The configured supplier scope cannot contain more than 1,000 sources.", 409);
  return [...currentIds, sourceId];
}

export function sanitizeSupplierSource(
  value: unknown,
  context: { existingSource?: FirebaseFirestore.DocumentData } = {},
): SanitizedSupplierSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Supplier source is invalid.", 400);
  assertNoCredentialValues(value);
  const source = value as Record<string, unknown>;
  const supplierName = cleanText(source.supplierName ?? source.name, "Supplier name", 160, true);
  const supplierType = cleanText(source.supplierType ?? source.type ?? source.connectorType, "Supplier connector type", 40, true).toLowerCase();
  if (!SOURCE_TYPES.has(supplierType)) throw new ApiError("Supplier connector type is invalid.", 400);
  const connectorType = cleanText(source.connectorType, "Supplier connector type", 40) || supplierType;
  const websiteUrl = cleanHttpUrl(source.websiteUrl, "Supplier website URL", ["a2z", "api", "http", "rest", "website"].includes(supplierType));
  const endpoint = cleanText(source.endpoint, "Supplier endpoint", MAX_TEXT_LENGTH);
  if (endpoint && /^https?:\/\//iu.test(endpoint)) cleanHttpUrl(endpoint, "Supplier endpoint");
  const sourceStatus = String(source.sourceStatus ?? (source.enabled === false ? "inactive" : "active")).toLowerCase();
  if (sourceStatus !== "active" && sourceStatus !== "inactive") throw new ApiError("Supplier source status is invalid.", 400);
  const priority = source.priority === undefined ? 100 : Number(source.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) throw new ApiError("Supplier priority is invalid.", 400);
  const currency = (cleanText(source.currency, "Supplier currency", 8) || "LKR").toUpperCase();
  const timezone = cleanText(source.timezone, "Supplier timezone", 100) || "Asia/Colombo";
  const syncSchedule = cleanText(source.syncSchedule, "Supplier sync schedule", 50) || "Off";
  return {
    supplierName,
    name: supplierName,
    supplierType,
    connectorType,
    websiteUrl,
    endpoint,
    sourceStatus: sourceStatus as "active" | "inactive",
    enabled: sourceStatus === "active",
    priority,
    currency,
    timezone,
    syncSchedule,
    capabilities: cleanStringList(source.capabilities, "Supplier capabilities", 30, 80),
    authentication: cleanAuthentication(
      source.authentication,
      connectorType === "a2z" && isMigratedLegacyA2ZSource(context.existingSource),
    ),
    config: cleanConfig(source.config),
    settings: cleanSettings(source.settings),
  };
}

const legacyCredentialDeletes = (): Record<string, FieldValue> => ({
  username: FieldValue.delete(), password: FieldValue.delete(), apiKey: FieldValue.delete(), apiToken: FieldValue.delete(),
  token: FieldValue.delete(), secret: FieldValue.delete(), authorization: FieldValue.delete(),
  "config.username": FieldValue.delete(), "config.password": FieldValue.delete(), "config.apiHeaders": FieldValue.delete(),
  "config.apiKey": FieldValue.delete(), "config.apiToken": FieldValue.delete(), "config.authorization": FieldValue.delete(),
  "settings.username": FieldValue.delete(), "settings.password": FieldValue.delete(), "settings.apiKey": FieldValue.delete(),
  "settings.apiToken": FieldValue.delete(), "settings.authorization": FieldValue.delete(),
});

export async function saveSupplierSource(
  db: Firestore,
  sourceId: string,
  value: unknown,
  actor: SupplierHubAdminIdentity,
  options: { createOnly?: boolean } = {},
): Promise<void> {
  const reference = db.collection("supplierSources").doc(sourceId);
  const settingsReference = db.collection("supplier_settings").doc("config");
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    const settingsSnapshot = options.createOnly ? await transaction.get(settingsReference) : null;
    if (options.createOnly && existing.exists) {
      throw new ApiError("A supplier source with this ID already exists.", 409);
    }
    const source = sanitizeSupplierSource(value, {
      existingSource: existing.exists ? existing.data() : undefined,
    });
    transaction.set(reference, {
      ...source,
      supplierId: existing.data()?.supplierId || sourceId,
      createdAt: existing.data()?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
      ...legacyCredentialDeletes(),
    }, { merge: true });
    const auditReference = db.collection("supplier_operations_audit").doc();
    transaction.create(auditReference, {
      id: auditReference.id,
      eventId: auditReference.id,
      module: "supplier_source",
      action: existing.exists ? "supplier_updated" : "supplier_created",
      supplierId: existing.data()?.supplierId || sourceId,
      sourceId,
      adminUserId: actor.uid,
      adminEmail: actor.email,
      timestamp: FieldValue.serverTimestamp(),
      changedFields: Object.keys(source).sort(),
    });
    const enabledSupplierIds = addSupplierSourceToConfiguredScope(settingsSnapshot?.data(), sourceId);
    if (enabledSupplierIds) {
      transaction.set(settingsReference, { enabledSupplierIds }, { merge: true });
    }
  });
}

export function sanitizeSupplierHubSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Supplier Hub settings are invalid.", 400);
  assertNoCredentialValues(value, "supplier settings");
  const settings = value as Record<string, unknown>;
  const maxProducts = Number(settings.maxProducts);
  const defaultImageLimit = Number(settings.defaultImageLimit);
  const defaultMarkup = Number(settings.defaultMarkup);
  const defaultProfitMargin = Number(settings.defaultProfitMargin);
  if (!Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 250) throw new ApiError("maxProducts is invalid.", 400);
  if (!Number.isInteger(defaultImageLimit) || defaultImageLimit < 1 || defaultImageLimit > 20) throw new ApiError("defaultImageLimit is invalid.", 400);
  if (!Number.isFinite(defaultMarkup) || defaultMarkup < 0 || defaultMarkup > 200) throw new ApiError("defaultMarkup is invalid.", 400);
  if (!Number.isFinite(defaultProfitMargin) || defaultProfitMargin < 0 || defaultProfitMargin > 100) throw new ApiError("defaultProfitMargin is invalid.", 400);
  const syncInterval = cleanText(settings.syncInterval, "syncInterval", 30) || "1 Hour";
  const categoryMappings = settings.categoryMappings && typeof settings.categoryMappings === "object" && !Array.isArray(settings.categoryMappings)
    ? Object.fromEntries(Object.entries(settings.categoryMappings as Record<string, unknown>)
      .filter(([key, entry]) => cleanText(key, "Category mapping", 160) && cleanText(entry, "Category mapping", 160))
      .slice(0, 1_000))
    : {};
  return {
    websiteSyncEnabled: settings.websiteSyncEnabled !== false,
    autoSyncEnabled: settings.autoSyncEnabled !== false,
    syncInterval,
    maxProducts,
    enabledSupplierIds: cleanStringList(settings.enabledSupplierIds, "enabledSupplierIds", 1_000, MAX_ID_LENGTH),
    enabledSupplierIdsConfigured: settings.enabledSupplierIdsConfigured === true,
    defaultProfitMargin,
    defaultMarkup,
    defaultImageLimit,
    categoryMappings,
  };
}

export async function saveSupplierHubSettings(
  db: Firestore,
  value: unknown,
  actor: SupplierHubAdminIdentity,
): Promise<void> {
  const settings = sanitizeSupplierHubSettings(value);
  await db.collection("supplier_settings").doc("config").set({
    ...settings,
    lastUpdated: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
  }, { merge: true });
}
