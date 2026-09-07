export interface SupplierSourceLike {
  id: string;
  sourceStatus?: unknown;
  supplierType?: unknown;
  type?: unknown;
  connectorType?: unknown;
  syncSchedule?: unknown;
  settings?: {
    autoSync?: unknown;
  } | Record<string, unknown>;
}

const SUPPLIER_AUTO_SYNC_VALUES = new Map([
  ['off', 'Off'],
  ['15 minutes', '15 Minutes'],
  ['30 minutes', '30 Minutes'],
  ['1 hour', '1 Hour'],
  ['3 hours', '3 Hours'],
  ['6 hours', '6 Hours'],
  ['daily', 'Daily'],
]);

/** `settings.autoSync` is canonical; `syncSchedule` is a legacy read fallback. */
export const resolveSupplierSourceAutoSyncSchedule = (
  canonicalAutoSync: unknown,
  legacySyncSchedule: unknown,
): string => {
  for (const candidate of [canonicalAutoSync, legacySyncSchedule]) {
    const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    const schedule = SUPPLIER_AUTO_SYNC_VALUES.get(normalized);
    if (schedule) return schedule;
  }
  return 'Off';
};

export const supplierSourceAutoSyncSchedule = (source: SupplierSourceLike): string =>
  resolveSupplierSourceAutoSyncSchedule(source.settings?.autoSync, source.syncSchedule);

/** A2Z/HTTP are concrete connectors transported by the legacy website feed. */
export const getSupplierSourceType = (source: SupplierSourceLike): string => {
  const configured = String(source.supplierType || source.type || '').trim().toLowerCase();
  if (configured) return ['a2z', 'http'].includes(configured) ? 'website' : configured;
  const connector = String(source.connectorType || '').trim().toLowerCase();
  return ['a2z', 'http'].includes(connector) ? 'website' : connector || 'website';
};

export const isActiveWebsiteSupplier = (source: SupplierSourceLike): boolean =>
  String(source.sourceStatus || 'active').trim().toLowerCase() === 'active' &&
  getSupplierSourceType(source) === 'website';

export const normalizeSupplierSourceForUi = <T extends Record<string, any> & { id: string }>(data: T): T & Record<string, any> => {
  const sourceType = getSupplierSourceType(data);
  return {
    ...data,
    name: data.supplierName || data.name || 'Unnamed Supplier',
    type: sourceType,
    supplierType: sourceType,
    websiteUrl: data.websiteUrl || data.config?.targetUrl || '',
    endpoint: data.endpoint || data.config?.apiEndpoint || '',
    connectionStatus: data.connectionStatus || 'Not Synced',
    sourceStatus: data.sourceStatus || 'active',
    lastSync: data.lastSync || null,
    lastError: data.lastError || 'None',
  };
};
