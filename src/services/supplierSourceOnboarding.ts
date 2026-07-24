export type SupplierOnboardingType = 'a2z' | 'website' | 'api';

export const A2Z_GLOBAL_SECRET_PROFILE = 'firebase-functions:a2z-global';

export interface SupplierOnboardingInput {
  id: string;
  supplierName: string;
  supplierType: SupplierOnboardingType;
  description?: string;
  websiteUrl?: string;
  endpoint?: string;
  apiMethod?: string;
  apiDataPath?: string;
  cssPriceSelector?: string;
  cssStockSelector?: string;
  cssImageSelector?: string;
  connectionStatus?: string;
  lastError?: string | null;
}

/**
 * Builds the browser-to-Functions onboarding contract. The legacy `website`
 * transport remains stable while `connectorType` selects the executable
 * server connector. Credential values never enter the browser payload.
 */
export function buildSupplierOnboardingSource(input: SupplierOnboardingInput): Record<string, unknown> {
  const connectorType = input.supplierType === 'a2z'
    ? 'a2z'
    : input.supplierType === 'api'
      ? 'rest'
      : 'http';
  const websiteUrl = (input.supplierType === 'api' ? input.endpoint : input.websiteUrl || '').trim();
  const endpoint = input.supplierType === 'website' ? (input.endpoint || '').trim() : '';
  const config: Record<string, string> = {};
  const setConfig = (field: string, value: string | undefined): void => {
    const normalized = String(value || '').trim();
    if (normalized) config[field] = normalized;
  };

  setConfig('description', input.description);
  if (input.supplierType === 'api') {
    setConfig('apiEndpoint', input.endpoint);
    setConfig('apiMethod', input.apiMethod || 'GET');
    setConfig('apiDataPath', input.apiDataPath);
  } else {
    setConfig('targetUrl', input.websiteUrl);
    if (input.supplierType === 'website') {
      setConfig('cssPriceSelector', input.cssPriceSelector);
      setConfig('cssStockSelector', input.cssStockSelector);
      setConfig('cssImageSelector', input.cssImageSelector);
    }
  }

  return {
    id: input.id.trim(),
    supplierId: input.id.trim(),
    supplierName: input.supplierName.trim(),
    name: input.supplierName.trim(),
    supplierType: 'website',
    connectorType,
    websiteUrl,
    endpoint,
    sourceStatus: 'active',
    enabled: true,
    priority: 100,
    currency: 'LKR',
    timezone: 'Asia/Colombo',
    syncSchedule: 'Off',
    capabilities: ['catalog.fetch', 'connection.test'],
    authentication: connectorType === 'a2z'
      ? { mode: 'secret_manager', credentialProfile: A2Z_GLOBAL_SECRET_PROFILE }
      : { mode: 'none' },
    connectionStatus: input.connectionStatus || 'Not Synced',
    lastSync: null,
    lastError: input.lastError || 'None',
    config,
  };
}
